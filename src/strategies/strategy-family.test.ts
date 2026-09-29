import { describe, expect, it } from 'vitest'
import {
  isSearchVariantId,
  resolveStrategyFamily,
  strategyFamilyKey,
} from './strategy-family'
import { canonicalSimId, candidateFromSearchRow } from './strategy-search-cycle'
import { isSearchStrategyId } from './strategy-search-bandit'
import type { StrategyChain, StrategyDomain } from './types'

const fam = (
  strategyId: string,
  domain: StrategyDomain,
  config?: Record<string, unknown> | null,
) => resolveStrategyFamily({ strategyId, domain, config })

const mcapVariantConfig = (entryTemplate: string) => ({ entry: { entryTemplate } })

describe('resolveStrategyFamily', () => {
  it('collapses the tp150/tp200/tp300 grid neighbours into one family', () => {
    const ids = [
      'search_mcap_first_seen_sl_30_tp150_h48',
      'search_mcap_first_seen_sl_30_tp200_h48',
      'search_mcap_first_seen_sl_30_tp300_h48',
    ]
    const families = ids.map((id) =>
      fam(id, 'mcap_tracker', mcapVariantConfig('first_seen')),
    )
    expect(new Set(families).size).toBe(1)
    expect(families[0]).toBe('mcap_enter_first_seen')
  })

  it('keeps the milestone_80 template in its own family', () => {
    expect(
      fam('search_mcap_milestone_80_sl_30_tp200_h48', 'mcap_tracker', mcapVariantConfig('milestone_80')),
    ).toBe('mcap_enter_at_80')
    expect(fam('search_mcap_first_seen_sl_30_tp200_h48', 'mcap_tracker', mcapVariantConfig('first_seen'))).not.toBe(
      fam('search_mcap_milestone_80_sl_30_tp200_h48', 'mcap_tracker', mcapVariantConfig('milestone_80')),
    )
  })

  it('collapses a variant onto its canonical strategy row', () => {
    expect(fam('search_mcap_first_seen_sl_30_tp200_h48', 'mcap_tracker', mcapVariantConfig('first_seen'))).toBe(
      fam('mcap_enter_first_seen', 'mcap_tracker'),
    )
  })

  it('maps signals and gmgn variants to their domain canonical', () => {
    expect(fam('search_signals_something', 'signals', {})).toBe('signals_default')
    expect(fam('search_gmgn_something', 'gmgn', {})).toBe('gmgn_smartmoney_default')
  })

  it('collapses _rh twins onto their sol sibling', () => {
    expect(fam('mcap_enter_first_seen_rh', 'mcap_tracker')).toBe('mcap_enter_first_seen')
    expect(fam('att_rh', 'trending_bot')).toBe('att')
  })

  it('keeps an unknown entry template in its own family instead of merging it', () => {
    // canonicalSimId would fall through to first_seen here; we must not.
    const id = 'search_mcap_experimental_sl_30_tp200_h48'
    expect(fam(id, 'mcap_tracker', { entry: { entryTemplate: 'custom_template' } })).toBe(id)
    expect(fam(id, 'mcap_tracker', null)).toBe(id)
  })

  it('treats an unknown strategy id as its own family', () => {
    expect(fam('some_new_strategy', 'mcap_tracker')).toBe('some_new_strategy')
  })

  it('scopes the family key by chain', () => {
    const chains: StrategyChain[] = ['sol', 'robinhood']
    const keys = chains.map((chain) => strategyFamilyKey(chain, 'mcap_enter_first_seen'))
    expect(new Set(keys).size).toBe(2)
    expect(keys).toEqual(['sol:mcap_enter_first_seen', 'robinhood:mcap_enter_first_seen'])
  })
})

/**
 * The restated rules in strategy-family.ts must not drift from the live ones. This
 * pins them: for every known entry template, the family equals what `canonicalSimId`
 * would promote the same variant to, and the search-id test equals `isSearchStrategyId`.
 */
describe('agrees with the live search helpers', () => {
  const templates = ['first_seen', 'milestone_80'] as const
  const domains: StrategyDomain[] = ['mcap_tracker', 'signals', 'gmgn']

  it('matches canonicalSimId for every known template', () => {
    for (const domain of domains) {
      for (const entryTemplate of templates) {
        const configId = `${entryTemplate}_sl-30_tp200_h48`
        const candidate = candidateFromSearchRow({
          domain,
          configId,
          config: { entry: { entryTemplate }, exit: { stopLossPct: -30, takeProfitPct: 200, maxHoldHours: 48 } },
        })
        const live = canonicalSimId(domain, candidate)
        expect(live, `${domain}/${entryTemplate}`).not.toBeNull()
        expect(
          fam(`search_${domain}_${configId}`, domain, { entry: { entryTemplate } }),
          `${domain}/${entryTemplate}`,
        ).toBe(live)
      }
    }
  })

  it('matches isSearchStrategyId', () => {
    const samples = [
      'search_mcap_x',
      'search_signals_x',
      'search_gmgn_x',
      'mcap_enter_first_seen',
      'att',
      'search_other_x',
    ]
    for (const id of samples) {
      expect(isSearchVariantId(id), id).toBe(isSearchStrategyId(id))
    }
  })
})
