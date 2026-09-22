import { describe, expect, it } from 'vitest'
import {
  isTrackedMcapPresence,
  mcapLabelFilterSql,
  mcapTrackedAlgoTesterHref,
  strategyPresenceTitle,
  trackerLabelDisplay,
} from './tracker-label'

const SEED = 'AVXPQqxd32ABAP5F7shHKNeWBpos9miktdH3uKqgXYJZ'

describe('mcapTrackedAlgoTesterHref', () => {
  it('includes tab, domain, mint, and chain', () => {
    const href = mcapTrackedAlgoTesterHref(SEED, 'sol')
    expect(href).toContain('tab=open')
    expect(href).toContain('domain=mcap_tracker')
    expect(href).toContain(`tokenAddress=${SEED}`)
    expect(href).toContain('chain=sol')
    expect(href.startsWith('/dev/algo-tester?')).toBe(true)
  })

  it('omits chain when the locate call was not chain-scoped', () => {
    const href = mcapTrackedAlgoTesterHref(SEED)
    expect(href).not.toMatch(/[?&]chain=/)
    expect(href).toContain(`tokenAddress=${SEED}`)
  })
})

describe('tracked presence copy', () => {
  it('titles a tracking row Tracked and keeps outcome rows on their strategy name', () => {
    const tracked = {
      source: 'token_mcap_tracking',
      strategyId: null,
      strategyName: null,
    }
    expect(isTrackedMcapPresence(tracked)).toBe(true)
    expect(strategyPresenceTitle(tracked)).toBe('Tracked')
    expect(strategyPresenceTitle(tracked)).not.toBe('token_mcap_tracking')

    const outcome = {
      source: 'strategy_outcomes',
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
    }
    expect(isTrackedMcapPresence(outcome)).toBe(false)
    expect(strategyPresenceTitle(outcome)).toBe('Enter at first seen')
  })
})

describe('trackerLabelDisplay', () => {
  it('maps rugged to Rug and hides null', () => {
    expect(trackerLabelDisplay('rugged')).toBe('Rug')
    expect(trackerLabelDisplay('potential')).toBe('Potential')
    expect(trackerLabelDisplay('traded_live')).toBe('Traded live')
    expect(trackerLabelDisplay(null)).toBeNull()
    expect(trackerLabelDisplay('rug')).toBeNull()
  })
})

describe('mcapLabelFilterSql', () => {
  it('rejects rug', () => {
    expect(mcapLabelFilterSql('rug', 2)).toHaveProperty('error')
  })
})
