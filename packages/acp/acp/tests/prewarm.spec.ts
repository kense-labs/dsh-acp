import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { KBOX_PREWARM_READY_MARKER, reportKboxPrewarmReady } from '../src/prewarm.ts'
import { makeBridgeHarness } from './harness.ts'

describe('kbox process prewarm readiness', () => {
  it('writes the exact stderr marker only when explicitly requested', () => {
    const output: string[] = []

    reportKboxPrewarmReady({}, (chunk) => output.push(chunk))
    expect(output).toEqual([])

    reportKboxPrewarmReady({ KBOX_PREWARM_READY: '0' }, (chunk) => output.push(chunk))
    expect(output).toEqual([])

    reportKboxPrewarmReady({ KBOX_PREWARM_READY: '1' }, (chunk) => output.push(chunk))
    expect(output).toEqual([KBOX_PREWARM_READY_MARKER])
    expect(output[0]).toBe('kbox-prewarm-ready-v1\n')
  })

  it('resolves model capabilities during mount and reuses them on every initialize', async () => {
    const harness = await makeBridgeHarness()
    try {
      const resolveModelInfo = vi.spyOn(harness.ctx.llm, 'resolveModelInfo')
      const request = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }

      await harness.client.initialize(request)
      await harness.client.initialize(request)

      expect(resolveModelInfo).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })
})
