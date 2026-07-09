import { describe, expect, it } from 'vitest'
import {
  buildMcapSimManualTradeAlertText,
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
})
