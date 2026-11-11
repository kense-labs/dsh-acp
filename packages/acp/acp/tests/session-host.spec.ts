import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP session access for Host services', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('creates the reserved session durably and attaches the client to its original agent', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('follow-up')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const host = harness.ctx.acpSessionHost
    const cwd = process.cwd()
    const id = SessionId('session-6f32b6de-c788-4161-93d5-c106bc59b5e8')

    await expect(host.activate(id)).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    const agent = await host.create(id, cwd)
    expect(agent.session.id).toBe(id)
    expect((await harness.ctx.sessionPersistence.stat(id))?.header.cwd).toBe(cwd)
    await expect(host.create(id, cwd)).rejects.toThrow(/already active/)
    await expect(host.openForClient(id, '/')).rejects.toThrow(/cwd does not match/)
    await expect(harness.client.resumeSession({ sessionId: id, cwd, mcpServers: [] }))
      .rejects.toThrow(/already active/)

    const attached = await Promise.allSettled([host.openForClient(id, cwd), host.openForClient(id, cwd)])
    expect(attached.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await host.activate(id)).toBe(agent)
    await expect(harness.client.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'continue' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await harness.client.closeSession({ sessionId: id })
    expect(harness.ctx.agents.get(id)).toBeUndefined()
  })

  it('coalesces cold activation and preserves the session after a concurrent close', async () => {
    harness = await makeBridgeHarness({ script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const id = SessionId((await harness.client.newSession({ cwd, mcpServers: [] })).sessionId)
    const host = harness.ctx.acpSessionHost
    const previous = await host.activate(id)
    await harness.client.closeSession({ sessionId: id })

    const [a, b] = await Promise.all([host.activate(id), host.activate(id)])
    expect(a).toBe(b)
    expect(a).not.toBe(previous)
    expect(a.session.id).toBe(id)
    expect(harness.ctx.agents.get(id)).toBe(a)
    await expect(host.openForClient(id, cwd)).resolves.toHaveProperty('configOptions')

    const closed = harness.client.closeSession({ sessionId: id })
    await closed
    const next = await host.activate(id)
    expect(next).not.toBe(a)
    expect(next.session.id).toBe(id)
  })
})
