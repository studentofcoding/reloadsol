import { describe, expect, it } from 'vitest'
import {
  buildMcapSimManualTradeAlertText,
  buildSignalsEarlyEnterAlertText,
  formatReloadsolBuyLink,
  formatReloadsolChartLink,
} from './telegram'

describe('buildMcapSimManualTradeAlertText', () => {
  it('includes copy-trade title, strategy label, and links', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      entryMcap: 85_000,
      entryAt: '2026-07-09T01:00:00.000Z',
    })

    expect(text).toContain('Mcap Sim OPEN — copy trade')
    expect(text).toContain('Enter at first seen')
    expect(text).toContain('mcap_enter_first_seen')
    expect(text).toContain('TEST')
    expect(text).toContain('$85.0K')
    expect(text).toContain('2026-07-09T01:00:00.000Z')
    expect(text).toContain(
      formatReloadsolChartLink('So11111111111111111111111111111111111111112'),
    )
    expect(text).toContain(
      formatReloadsolBuyLink('So11111111111111111111111111111111111111112'),
    )
    expect(text).toContain('jup.ag/tokens/')
  })

  it('escapes HTML in symbol and strategy name', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_at_80',
      strategyName: 'Enter <at> 80%',
      tokenSymbol: 'A&B',
      tokenAddress: 'MintABC',
      entryMcap: 120_000,
    })

    expect(text).toContain('Enter &lt;at&gt; 80%')
    expect(text).toContain('A&amp;B')
    expect(text).not.toContain('Enter <at> 80%')
  })

  it('includes Live mcap when it differs from entry', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_at_80',
      strategyName: 'Enter at 80% milestone',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      entryMcap: 135_400,
      liveMcap: 478_000,
    })
    expect(text).toContain('Entry mcap: $135.4K')
    expect(text).toContain('Live mcap: $478.0K')
  })
})

describe('buildSignalsEarlyEnterAlertText', () => {
  it('includes early-enter title, growth under 100%, and links', () => {
    const text = buildSignalsEarlyEnterAlertText({
      tokenSymbol: 'EARLY',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
      rationale: 'Strong momentum and recency',
      entryAt: '2026-07-09T01:00:00.000Z',
    })

    expect(text).toContain('Early Signals Enter — copy trade')
    expect(text).toContain('EARLY')
    expect(text).toContain('+35.4%')
    expect(text).toContain('before 100%')
    expect(text).toContain('$70.0K')
    expect(text).toContain('Strong momentum and recency')
    expect(text).toContain('Pattern ML (shadow): n/a')
    expect(text).toContain(
      formatReloadsolChartLink('So11111111111111111111111111111111111111112'),
    )
  })

  it('includes Pattern ML shadow line when scored', () => {
    const text = buildSignalsEarlyEnterAlertText({
      tokenSymbol: 'EARLY',
      tokenAddress: 'MintABC',
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
      pWinner: 0.42,
      predicted: 'loser',
    })
    expect(text).toContain('Pattern ML (shadow): pW 0.42 → loser')
  })
})
