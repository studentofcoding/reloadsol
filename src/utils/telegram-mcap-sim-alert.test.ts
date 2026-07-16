import { describe, expect, it } from 'vitest'
import {
  buildMcapSimManualTradeAlertText,
  buildSignalsEarlyEnterAlertText,
  formatJupiterTokenLink,
  formatReloadsolChartLink,
} from './telegram'

const MINT = 'So11111111111111111111111111111111111111112'

describe('buildMcapSimManualTradeAlertText', () => {
  it('includes copy-trade title, strategy label, Chart + Jupiter Buy', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: MINT,
      entryMcap: 85_000,
      entryAt: '2026-07-09T01:00:00.000Z',
    })

    expect(text).toContain('Mcap Sim OPEN — copy trade')
    expect(text).toContain('Enter at first seen')
    expect(text).toContain('mcap_enter_first_seen')
    expect(text).toContain('TEST')
    expect(text).toContain('$85.0K')
    expect(text).toContain('2026-07-09T01:00:00.000Z')
    expect(text).toContain(formatReloadsolChartLink(MINT))
    expect(text).toContain(formatJupiterTokenLink(MINT))
    expect(text).toContain('>Buy</a>')
    expect(text).not.toContain('>Jupiter</a>')
    expect(text).not.toContain('reloadsol.app/buy')
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

  it('includes SM·KOL when shared mint peaks are present', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      entryMcap: 85_000,
      sm: 6,
      kol: 2,
    })
    expect(text).toContain('SM 6 · KOL 2')
  })

  it('omits SM·KOL when both zero', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      entryMcap: 85_000,
      sm: 0,
      kol: 0,
    })
    expect(text).not.toContain('SM ')
    expect(text).not.toContain('KOL ')
  })

  it('logs organic + top10 when already on snapshot', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      entryMcap: 85_000,
      organicScore: 72.4,
      topHoldersPct: 18.2,
    })
    expect(text).toContain('Organic 72 · top10 18%')
  })

  it('omits organic/holders when both null', () => {
    const text = buildMcapSimManualTradeAlertText({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      entryMcap: 85_000,
    })
    expect(text).not.toContain('Organic')
    expect(text).not.toContain('top10')
  })
})

describe('buildSignalsEarlyEnterAlertText', () => {
  it('includes early-enter title, growth under 100%, and Jupiter Buy', () => {
    const text = buildSignalsEarlyEnterAlertText({
      tokenSymbol: 'EARLY',
      tokenAddress: MINT,
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
      rationale: 'Strong momentum and recency',
      entryAt: '2026-07-09T01:00:00.000Z',
      strategyIds: ['signals_default'],
    })

    expect(text).toContain('Early Signals Enter — copy trade')
    expect(text).toContain('Strategies: signals_default')
    expect(text).toContain('EARLY')
    expect(text).toContain('+35.4%')
    expect(text).toContain('before 100%')
    expect(text).toContain('$70.0K')
    expect(text).toContain('Strong momentum and recency')
    expect(text).toContain('Pattern ML (shadow): n/a')
    expect(text).toContain(formatReloadsolChartLink(MINT))
    expect(text).toContain(formatJupiterTokenLink(MINT))
    expect(text).not.toContain('>Jupiter</a>')
  })

  it('lists known strategies including active mcap ids', () => {
    const text = buildSignalsEarlyEnterAlertText({
      tokenSymbol: 'EARLY',
      tokenAddress: 'MintABC',
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
      strategyIds: [
        'signals_default',
        'mcap_enter_at_80',
        'mcap_enter_first_seen',
      ],
    })
    expect(text).toContain(
      'Strategies: signals_default · mcap_enter_at_80 · mcap_enter_first_seen',
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

  it('includes SM·KOL when shared mint peaks are present', () => {
    const text = buildSignalsEarlyEnterAlertText({
      tokenSymbol: 'EARLY',
      tokenAddress: 'MintABC',
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
      sm: 4,
      kol: 1,
    })
    expect(text).toContain('SM 4 · KOL 1')
  })
})
