import { describe, expect, it } from 'vitest'
import { buildStrategyId, slugify } from './crosscheck-slug'
import {
  BLACK_COBRA_ALERT_EXAMPLE,
  parseTelegramAlert,
} from './parse-telegram-alert'

describe('parseTelegramAlert', () => {
  it('parses Black Cobra example — coin fields only, not channel', () => {
    const parsed = parseTelegramAlert(BLACK_COBRA_ALERT_EXAMPLE)
    expect(parsed).not.toBeNull()
    expect(parsed!.token_address).toBe('oVDNWQ6ZPQEPp9hcP6WheeacZncyy7ubHrwnKGDpump')
    expect(parsed!.token_name).toBe('The Black Cobra')
    expect(parsed!.token_symbol).toBe('TATE')
    expect(parsed!.signal_price_usd).toBeCloseTo(0.0000679, 10)
    expect(parsed!.signal_pct_change).toBe(34)
    expect(parsed!.dex).toBe('PumpSwap')
    expect(parsed!.market_cap_usd).toBeCloseTo(70300, 0)
    expect(parsed!.buy_sol_3m).toBe(54)
  })

  it('returns null without USD price', () => {
    expect(parseTelegramAlert('some text without price')).toBeNull()
  })

  it('returns null without mint', () => {
    expect(parseTelegramAlert('USD: $0.001 (+1%)')).toBeNull()
  })
})

describe('buildStrategyId', () => {
  it('uses manual channel name, not coin title', () => {
    expect(buildStrategyId('PumpSwap', 'cluster', 'GMGN Alpha')).toBe(
      'pumpswap_cluster_gmgn-alpha',
    )
    expect(slugify('The Black Cobra')).toBe('the-black-cobra')
    expect(buildStrategyId('PumpSwap', 'cluster', 'The Black Cobra')).toBe(
      'pumpswap_cluster_the-black-cobra',
    )
  })
})
