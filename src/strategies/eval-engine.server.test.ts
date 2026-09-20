import { describe, expect, it } from 'vitest'
import { runEvalScan } from './eval-engine.server'
import type { CombinedScoreResponse } from './combined-score'

const score = (combined: number, mlScore: number | null = 0.8): CombinedScoreResponse => ({
  success: true,
  mint: 'MintA',
  chain: 'sol',
  hours: 24,
  combined,
  weights: {
    principal: 0.55,
    adjusterPresence: 0.2,
    jaccard: 0.15,
    ohlcPattern: 0.1,
  },
  parts: {
    principalScore: 1,
    adjusterPresenceScore: 0,
    jaccardScore: null,
    ohlcPatternScore: 0.5,
  },
  principals: [],
  adjusters: [],
  mlScore,
  modelVersion: 'cl-test',
  generatedAt: '2026-09-20T12:00:00.000Z',
})

describe('runEvalScan', () => {
  it('does nothing when EVAL_ENGINE is off', async () => {
    const result = await runEvalScan({
      env: {},
      persist: async () => {},
      listCandidates: async () => [
        {
          mint: 'MintA',
          strategyId: 'mcap_enter_at_80',
          chain: 'sol',
          alreadyOpen: false,
          alreadyClosed: false,
          eligible: true,
          eligibilityReason: null,
        },
      ],
    })
    expect(result.summary.enabled).toBe(false)
    expect(result.summary.scanned).toBe(0)
    expect(result.decisions).toHaveLength(0)
  })

  it('opens paper above threshold and skips a second scan of the same mint', async () => {
    const opened = new Set<string>()
    const env = { EVAL_ENGINE: '1', ML_CLOSED_LOOP: '1' }
    const candidates = [
      {
        mint: 'MintA',
        strategyId: 'mcap_enter_at_80' as const,
        chain: 'sol' as const,
        alreadyOpen: false,
        alreadyClosed: false,
        eligible: true,
        eligibilityReason: null,
      },
    ]
    const first = await runEvalScan({
      env,
      persist: async () => {},
      loadCombinedScore: async () => score(0.7, 0.8),
      listCandidates: async () => candidates,
      paper: {
        isOpen: async (mint) => opened.has(`${mint}:mcap_enter_at_80`),
        isClosed: async () => false,
        openPaper: async (ctx) => {
          opened.add(`${ctx.decision.mint}:${ctx.decision.strategyId}`)
          return { ok: true, opened: true }
        },
      },
    })
    expect(first.decisions[0].action).toBe('paper_open')
    expect(first.summary.paperOpened).toBe(1)

    const second = await runEvalScan({
      env,
      persist: async () => {},
      loadCombinedScore: async () => score(0.7, 0.8),
      listCandidates: async () =>
        candidates.map((c) => ({ ...c, alreadyOpen: opened.has(`${c.mint}:${c.strategyId}`) })),
      paper: {
        isOpen: async (mint, strategyId) => opened.has(`${mint}:${strategyId}`),
        isClosed: async () => false,
        openPaper: async () => {
          throw new Error('should not open twice')
        },
      },
    })
    expect(second.decisions[0].action).toBe('skip')
    expect(second.decisions[0].reason).toBe('already_open')
    expect(second.summary.paperOpened).toBe(0)
  })
})
