import { describe, expect, it } from 'vitest'
import { buildEvalDecision } from './eval-engine'
import { PaperExecutionAdapter } from './eval-execution'

describe('PaperExecutionAdapter', () => {
  const decision = buildEvalDecision(
    {
      mint: 'MintA',
      strategyId: 'mcap_enter_at_80',
      combined: 0.7,
      mlScore: 0.8,
    },
    { env: { EVAL_ENGINE: '1', EVAL_SHADOW: '0' } },
  )

  it('does not double-open when the mint is already open', async () => {
    const adapter = new PaperExecutionAdapter({
      isOpen: async () => true,
      isClosed: async () => false,
      openPaper: async () => {
        throw new Error('should not open')
      },
    })
    const result = await adapter.open(decision)
    expect(result.ok).toBe(true)
    expect(result.opened).toBe(false)
    expect(result.error).toBe('already_open')
  })

  it('opens once through the injected paper path', async () => {
    let calls = 0
    const adapter = new PaperExecutionAdapter({
      isOpen: async () => false,
      isClosed: async () => false,
      openPaper: async () => {
        calls += 1
        return { ok: true, opened: true }
      },
    })
    const first = await adapter.open(decision)
    expect(first.opened).toBe(true)
    expect(calls).toBe(1)
  })
})
