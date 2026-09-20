import { describe, expect, it } from 'vitest'
import {
  LIVE_NOT_ENABLED,
  LIVE_STUB_NO_BROKER,
  buildEvalDecision,
  buildEvalReport,
  decideEvalAction,
  evalLiveGateError,
  getEvalExecMode,
  isEvalEngineEnabled,
  isEvalShadowEnabled,
  allowsEvalOpens,
  selectDiverseEvalCandidates,
} from './eval-engine'
import { LiveExecutionAdapter } from './eval-execution'

describe('eval flags', () => {
  it('defaults engine off, shadow on, and mode paper', () => {
    expect(isEvalEngineEnabled({})).toBe(false)
    expect(isEvalShadowEnabled({})).toBe(true)
    expect(isEvalShadowEnabled({ EVAL_SHADOW: '1' })).toBe(true)
    expect(isEvalShadowEnabled({ EVAL_SHADOW: '0' })).toBe(false)
    expect(allowsEvalOpens({})).toBe(false)
    expect(allowsEvalOpens({ EVAL_ENGINE: '1' })).toBe(false)
    expect(allowsEvalOpens({ EVAL_ENGINE: '1', EVAL_SHADOW: '0' })).toBe(true)
    expect(getEvalExecMode({})).toBe('paper')
    expect(evalLiveGateError({ EVAL_EXEC_MODE: 'paper', LIVE_TRADE_ENABLED: '1' })).toBe(
      LIVE_NOT_ENABLED,
    )
    expect(evalLiveGateError({ EVAL_EXEC_MODE: 'live', LIVE_TRADE_ENABLED: '0' })).toBe(
      LIVE_NOT_ENABLED,
    )
    expect(evalLiveGateError({ EVAL_EXEC_MODE: 'live', LIVE_TRADE_ENABLED: '1' })).toBeNull()
  })
})

describe('decideEvalAction', () => {
  const base = {
    mint: 'MintA',
    strategyId: 'mcap_enter_at_80',
    combined: 0.6,
    mlScore: 0.7,
  }

  it('shadow-predicts below combined or ml thresholds (keeps reason)', () => {
    const lowCombined = decideEvalAction(
      { ...base, combined: 0.2 },
      { env: { ML_CLOSED_LOOP: '1' } },
    )
    expect(lowCombined.action).toBe('shadow_predict')
    expect(lowCombined.reason).toBe('low_combined')
    const lowMl = decideEvalAction(
      { ...base, mlScore: 0.2 },
      { env: { ML_CLOSED_LOOP: '1' } },
    )
    expect(lowMl.action).toBe('shadow_predict')
    expect(lowMl.reason).toBe('low_ml')
    expect(
      decideEvalAction(
        { ...base, combined: 0.2 },
        { env: { EVAL_ENGINE: '1', EVAL_SHADOW: '0', ML_CLOSED_LOOP: '1' } },
      ).action,
    ).toBe('skip')
    expect(
      decideEvalAction(
        { ...base, mlScore: 0.2 },
        { env: { ML_CLOSED_LOOP: '0', EVAL_ENGINE: '1', EVAL_SHADOW: '0' } },
      ).action,
    ).toBe('paper_open')
  })

  it('shadow-predicts not_eligible when scores exist', () => {
    const decided = decideEvalAction({
      ...base,
      eligible: false,
      eligibilityReason: 'rugged',
    })
    expect(decided.action).toBe('shadow_predict')
    expect(decided.reason).toBe('rugged')
  })

  it('hard-skips when there is nothing to score', () => {
    expect(decideEvalAction({ ...base, strategyId: 'other' }).action).toBe('skip')
    expect(decideEvalAction({ ...base, strategyId: 'other' }).reason).toBe('not_principal')
    const noScores = decideEvalAction({
      ...base,
      combined: null,
      mlScore: null,
    })
    expect(noScores.action).toBe('skip')
    expect(noScores.reason).toBe('no_combined')
    const mlOnly = decideEvalAction({
      ...base,
      combined: null,
      mlScore: 0.6,
    })
    expect(mlOnly.action).toBe('shadow_predict')
    expect(mlOnly.reason).toBe('no_combined')
  })

  it('ignores ml threshold when mlScore is null', () => {
    const decided = decideEvalAction(
      { ...base, mlScore: null },
      { env: { ML_CLOSED_LOOP: '1', EVAL_ENGINE: '1', EVAL_SHADOW: '0' } },
    )
    expect(decided.action).toBe('paper_open')
  })

  it('attaches a shadow prediction to already-open / already-closed', () => {
    expect(decideEvalAction({ ...base, alreadyOpen: true }).action).toBe('shadow_predict')
    expect(decideEvalAction({ ...base, alreadyOpen: true }).reason).toBe('already_open')
    expect(decideEvalAction({ ...base, alreadyClosed: true }).action).toBe('shadow_predict')
    expect(
      decideEvalAction({ ...base, alreadyOpen: true }, { env: { EVAL_SHADOW: '0' } }).action,
    ).toBe('skip')
  })

  it('shadow-predicts by default and only opens when shadow is off', () => {
    expect(decideEvalAction(base, { env: {} }).action).toBe('shadow_predict')
    expect(decideEvalAction(base, { env: { EVAL_EXEC_MODE: 'live' } }).action).toBe(
      'shadow_predict',
    )
    expect(
      decideEvalAction(base, { env: { EVAL_ENGINE: '1', EVAL_SHADOW: '0' } }).action,
    ).toBe('paper_open')
    expect(
      decideEvalAction(base, {
        env: { EVAL_ENGINE: '1', EVAL_SHADOW: '0', EVAL_EXEC_MODE: 'live' },
      }).action,
    ).toBe('live_open')
    const decision = buildEvalDecision(base)
    expect(decision.mint).toBe('MintA')
    expect(decision.action).toBe('shadow_predict')
    expect(decision.reason).toBe('predicted')
  })
})

describe('selectDiverseEvalCandidates', () => {
  it('interleaves eligible with the rest so one bucket cannot fill the limit', () => {
    const candidates = [
      { id: 'c1', eligible: false },
      { id: 'c2', eligible: false },
      { id: 'c3', eligible: false },
      { id: 'e1', eligible: true },
      { id: 'e2', eligible: true },
    ]
    expect(selectDiverseEvalCandidates(candidates, 4).map((c) => c.id)).toEqual([
      'e1',
      'c1',
      'e2',
      'c2',
    ])
  })
})

describe('buildEvalReport', () => {
  it('aggregates tagged vs baseline outcomes', () => {
    const report = buildEvalReport({
      days: 7,
      decisions: [
        { action: 'skip' },
        { action: 'skip' },
        { action: 'shadow_predict' },
        { action: 'paper_open' },
      ],
      evalOutcomes: [
        { pnl_pct: 40, status: 'won' },
        { pnl_pct: -20, status: 'lost' },
      ],
      baselineOutcomes: [
        { pnl_pct: 10, status: 'won' },
        { pnl_pct: 5, status: 'won' },
        { pnl_pct: -8, status: 'lost' },
      ],
    })
    expect(report.decisions.total).toBe(4)
    expect(report.decisions.shadow_predict).toBe(1)
    expect(report.decisions.openRate).toBeCloseTo(0.25)
    expect(report.evalTagged.n).toBe(2)
    expect(report.evalTagged.winRate).toBeCloseTo(0.5)
    expect(report.baseline.n).toBe(3)
    expect(report.baseline.wins).toBe(2)
  })
})

describe('LiveExecutionAdapter', () => {
  const decision = buildEvalDecision({
    mint: 'MintA',
    strategyId: 'mcap_enter_first_seen',
    combined: 0.7,
    mlScore: 0.8,
  })

  it('refuses without both live flags', async () => {
    const adapter = new LiveExecutionAdapter({ EVAL_EXEC_MODE: 'paper' })
    const result = await adapter.open(decision)
    expect(result.ok).toBe(false)
    expect(result.error).toBe(LIVE_NOT_ENABLED)
    expect(result.opened).toBe(false)
  })

  it('is a no-op stub even when both live flags are on', async () => {
    const adapter = new LiveExecutionAdapter({
      EVAL_EXEC_MODE: 'live',
      LIVE_TRADE_ENABLED: '1',
    })
    const result = await adapter.open(decision)
    expect(result.ok).toBe(false)
    expect(result.error).toBe(LIVE_STUB_NO_BROKER)
    expect(result.opened).toBe(false)
  })
})
