/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes persistent harness sessions to trusted programmatic
 * clients. It carries standard configuration, MCP mounts, prompt content,
 * committed semantic updates, cancellation, and one-shot permission decisions;
 * presentation and human-interaction features stay with the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { supportsAcpImagePrompts } from './content.ts'
import { reportKboxPrewarmReady } from './prewarm.ts'
import { AcpMcpConfigError } from './mcp.ts'
import { AcpModelConfigError } from './model-control.ts'
import { AcpSession } from './session.ts'

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100

/** In-process session access for Host services that deliver work independently of a client prompt. */
interface AcpSessionHost {
  /** Resolve the owned Agent, restoring a persisted root session when needed; concurrent opens share one activation. */
  activate(sessionId: SessionId): Promise<AcpSession['agent']>
  /** Create and flush a root session with the exact reserved id; an existing id or a failed flush rejects. */
  create(sessionId: SessionId, cwd: string): Promise<AcpSession['agent']>
  /** Attach one client to a background session after workspace validation, or resume an inactive session. */
  openForClient(sessionId: SessionId, cwd: string): Promise<ResumeSessionResponse>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpSessionHost: AcpSessionHost
  }
}

export const name = 'acp'
/** Core services required by the standard automation controls. */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

function rethrowMcpError(error: unknown): never {
  if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
  throw error
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
})

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize)
  const sessions = new Map<SessionId, AcpSession>()
  const activating = new Map<SessionId, Promise<ResumeSessionResponse>>()
  const backgroundSessions = new Set<SessionId>()
  const closing = new Map<SessionId, Promise<void>>()
  const lifetime = new AbortController()
  let closed = false
  let imagePromptEnabled = false
  // Resolve model capabilities while the process is being prewarmed, not on the
  // client's first initialize request. The promise is owned by this ACP instance.
  const imagePromptsReady = supportsAcpImagePrompts(ctx, config.provider, config.model)
    .then((enabled) => { imagePromptEnabled = enabled })

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  function startActivation(
    sessionId: SessionId,
    open: () => Promise<ResumeSessionResponse>,
  ): Promise<ResumeSessionResponse> {
    assertOpen()
    if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
      throw invalidParams(`session is already active: ${sessionId}`)
    }
    const pending = Promise.resolve().then(open).finally(() => { activating.delete(sessionId) })
    activating.set(sessionId, pending)
    return pending
  }

  async function registerSession(
    record: AcpSession,
    signal: AbortSignal,
    fresh: boolean,
    background: boolean,
  ): Promise<ResumeSessionResponse> {
    const { session } = record.agent
    try {
      signal.throwIfAborted()
      assertOpen()
      sessions.set(session.id, record)
      const configOptions = await record.configOptions(signal)
      // The attached log writer's flush materializes an empty session durably.
      if (fresh && !await ctx.sessions.flush(session) && background) {
        throw internalError('session persistence did not acknowledge creation')
      }
      signal.throwIfAborted()
      assertOpen()
      if (closing.has(session.id) || sessions.get(session.id) !== record) {
        throw invalidParams(`session closed during activation: ${session.id}`)
      }
      if (background) backgroundSessions.add(session.id)
      return { configOptions }
    } catch (error: unknown) {
      try {
        await record.close('ACP session activation failed')
      } finally {
        if (sessions.get(session.id) === record) sessions.delete(session.id)
      }
      throw error
    }
  }

  function createSession(
    sessionId: SessionId,
    params: NewSessionRequest,
    signal: AbortSignal,
    background = false,
  ): Promise<ResumeSessionResponse> {
    validateWorkspaceParams(params)
    return startActivation(sessionId, async () => {
      signal.throwIfAborted()
      if (background && await persistence.stat(sessionId, { signal }) !== undefined) {
        throw invalidParams(`session already exists: ${sessionId}`)
      }
      // The ACP profile provides model-facing rows at the Host level.
      const record = await AcpSession.create(ctx, {
        sessionId, cwd: params.cwd, mcpServers: params.mcpServers,
        agentOptions: agentOptions(config), signal, notify,
      }).catch(rethrowMcpError)
      return registerSession(record, signal, true, background)
    })
  }

  function resumeSession(
    sessionId: SessionId,
    params: ResumeSessionRequest | undefined,
    signal: AbortSignal,
  ): Promise<ResumeSessionResponse> {
    if (params !== undefined) validateWorkspaceParams(params)
    return startActivation(sessionId, async () => {
      const persisted = (await persistence.stat(sessionId, { signal }))?.header
      if (persisted === undefined && params === undefined) {
        throw new SessionPersistenceNotFoundError(sessionId)
      }
      if (persisted === undefined || persisted.origin === 'subagent') {
        throw invalidParams(`session is not resumable: ${sessionId}`)
      }
      const cwd = params?.cwd ?? persisted.cwd
      if (cwd === undefined || !isAbsolute(cwd) || !await sameDirectory(persisted.cwd, cwd)) {
        throw invalidParams(`session cwd does not match: ${String(cwd)}`)
      }
      const record = await AcpSession.resume(ctx, {
        sessionId, cwd, mcpServers: params?.mcpServers ?? [],
        agentOptions: agentOptions(config), signal, notify,
      }).catch(rethrowMcpError)
      if (!await sameDirectory(record.agent.session.header.cwd, cwd)) {
        await record.close('session/resume cwd mismatch')
        throw invalidParams(`session cwd does not match: ${cwd}`)
      }
      return registerSession(record, signal, false, params === undefined)
    })
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification)
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event)
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(() => {
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      return conn.request(methods.client.session.requestPermission, params)
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      await imagePromptsReady
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve()
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      const sessionId = brandString<SessionId>(randomUUID())
      return { sessionId, ...await createSession(sessionId, params, AbortSignal.any([signal, lifetime.signal])) }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      return resumeSession(brandString<SessionId>(params.sessionId), params, AbortSignal.any([signal, lifetime.signal]))
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || header.origin === 'subagent'
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd, createdAt }) => ({ sessionId, cwd, createdAt })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      const disposed = record.close('ACP session closed')
      closing.set(sessionId, disposed)
      try {
        await disposed
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
        if (closing.get(sessionId) === disposed) closing.delete(sessionId)
        backgroundSessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  const connection = app.connect(stream)
  const conn: AgentContext = connection.client
  /** Join in-flight ownership before borrowing the exact record for this id. */
  async function withStableSession<T>(
    sessionId: SessionId,
    use: (record: AcpSession | undefined) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      assertOpen()
      const teardown = closing.get(sessionId)
      if (teardown !== undefined) {
        await teardown
        continue
      }
      const pending = activating.get(sessionId)
      if (pending === undefined) return use(sessions.get(sessionId))
      // If a client-side open failed, a Host open can still use the stored cwd.
      await pending.catch(() => undefined)
    }
  }
  ctx.provide('acpSessionHost', {
    activate(sessionId) {
      return withStableSession(sessionId, async (record) => {
        if (record !== undefined) return record.agent
        await resumeSession(sessionId, undefined, lifetime.signal)
        return requireSession(sessionId).agent
      })
    },
    async create(sessionId, cwd) {
      await createSession(sessionId, { cwd, mcpServers: [] }, lifetime.signal, true)
      return requireSession(sessionId).agent
    },
    async openForClient(sessionId, cwd) {
      validateWorkspaceParams({ cwd })
      return withStableSession(sessionId, async (record) => {
        if (record === undefined) {
          return resumeSession(sessionId, { sessionId, cwd, mcpServers: [] }, lifetime.signal)
        }
        if (!backgroundSessions.has(sessionId)) throw invalidParams(`session is already active: ${sessionId}`)
        if (!await sameDirectory(record.agent.session.header.cwd, cwd)) {
          throw invalidParams(`session cwd does not match: ${cwd}`)
        }
        const configOptions = await record.configOptions(lifetime.signal)
        assertOpen()
        if (closing.has(sessionId) || sessions.get(sessionId) !== record || !backgroundSessions.delete(sessionId)) {
          throw invalidParams(`session ownership changed during activation: ${sessionId}`)
        }
        return { configOptions }
      })
    },
  })
  // Readiness means both the stdio connection and the capabilities used by the
  // first initialize response are complete. Stdout remains JSON-RPC only.
  void imagePromptsReady.then(() => { reportKboxPrewarmReady() })

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    lifetime.abort()
    const openings = [...activating.values()]
    const records = [...sessions.values()]
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      await Promise.allSettled(openings)
      for (const record of records) {
        /* v8 ignore next -- closed blocks concurrent handlers; each captured record remains mapped until this loop. */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      backgroundSessions.clear()
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Resolve and validate the deployment-owned session page limit. */
function resolveSessionListPageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE
  /* v8 ignore start -- Cordis applies the positive-integer Config schema; this protects direct apply callers. */
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('acp: sessionListPageSize must be a positive safe integer')
  }
  /* v8 ignore stop */
  return resolved
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
