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
} from './eval-engine'
import { LiveExecutionAdapter } from './eval-execution'

describe('eval flags', () => {
  it('defaults engine off and mode paper', () => {
    expect(isEvalEngineEnabled({})).toBe(false)
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

  it('skips below combined or ml thresholds', () => {
    expect(
      decideEvalAction(
        { ...base, combined: 0.2 },
        { env: { ML_CLOSED_LOOP: '1' } },
      ).reason,
    ).toBe('low_combined')
    expect(
      decideEvalAction(
        { ...base, mlScore: 0.2 },
        { env: { ML_CLOSED_LOOP: '1' } },
      ).reason,
    ).toBe('low_ml')
    expect(
      decideEvalAction(
        { ...base, mlScore: 0.2 },
        { env: { ML_CLOSED_LOOP: '0' } },
      ).action,
    ).toBe('paper_open')
  })

  it('ignores ml threshold when mlScore is null', () => {
    const decided = decideEvalAction(
      { ...base, mlScore: null },
      { env: { ML_CLOSED_LOOP: '1' } },
    )
    expect(decided.action).toBe('paper_open')
  })

  it('skips already-open / already-closed / not eligible', () => {
    expect(decideEvalAction({ ...base, alreadyOpen: true }).reason).toBe('already_open')
    expect(decideEvalAction({ ...base, alreadyClosed: true }).reason).toBe('already_closed')
    expect(
      decideEvalAction({ ...base, eligible: false, eligibilityReason: 'rugged' }).reason,
    ).toBe('rugged')
  })

  it('opens paper by default and live_open when mode is live', () => {
    expect(decideEvalAction(base, { env: {} }).action).toBe('paper_open')
    expect(decideEvalAction(base, { env: { EVAL_EXEC_MODE: 'live' } }).action).toBe(
      'live_open',
    )
    const decision = buildEvalDecision(base)
    expect(decision.mint).toBe('MintA')
    expect(decision.reason).toBe('opened')
  })
})

describe('buildEvalReport', () => {
  it('aggregates tagged vs baseline outcomes', () => {
    const report = buildEvalReport({
      days: 7,
      decisions: [
        { action: 'skip' },
        { action: 'skip' },
        { action: 'paper_open' },
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
    expect(report.decisions.openRate).toBeCloseTo(0.5)
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
