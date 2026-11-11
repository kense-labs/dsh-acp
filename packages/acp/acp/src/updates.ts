/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'

/** Host extension: waking non-human user messages projected as turn triggers. */
export type TurnTriggerUpdate = {
  sessionUpdate: 'turn_trigger'
  messageId: string
  sourceKind: string
  content: string
  time?: number
}

/** Host extension: durable turn boundary for clients without an open prompt RPC. */
export type TurnEndUpdate = {
  sessionUpdate: 'turn_end'
  turn: number
  reason: string
}

export type ExtendedSessionUpdate = SessionUpdate | TurnTriggerUpdate | TurnEndUpdate

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}

/**
 * Project a waking (non-human) user message as a turn-trigger card for ACP clients.
 * Human `kind: "user"` prompts are echoed by the client composer and omitted here.
 */
export function turnTriggerUpdate(event: SessionEvent<'user/message'>): TurnTriggerUpdate | undefined {
  const source = event.data.source
  const kind = typeof source === 'object' && source !== null && 'kind' in source
    ? String((source as { kind?: unknown }).kind ?? '')
    : ''
  if (!kind || kind === 'user' || kind === 'skill-catalog' || kind === 'plugin') {
    return undefined
  }
  const content = Array.isArray(event.data.content)
    ? event.data.content
      .map((block) => {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text'
          && 'text' in block && typeof block.text === 'string') {
          return block.text
        }
        return ''
      })
      .filter((text) => text.length > 0)
      .join('\n')
    : ''
  if (!content.trim()) return undefined
  return {
    sessionUpdate: 'turn_trigger',
    messageId: event.data.id,
    sourceKind: kind,
    content,
    time: event.time,
  }
}

/** Project a durable turn/end so clients can close autonomous goal rounds. */
export function turnEndUpdate(event: SessionEvent<'turn/end'>): TurnEndUpdate {
  return {
    sessionUpdate: 'turn_end',
    turn: event.data.turn,
    reason: String(event.data.reason ?? 'completed'),
  }
}
