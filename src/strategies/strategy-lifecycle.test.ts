import { describe, expect, it } from 'vitest'
import {
  deriveStrategyLifecycle,
  isArchivedSearchVariant,
  partitionByLifecycle,
} from './strategy-lifecycle'

describe('deriveStrategyLifecycle (same rule as the Workers table, b0a9d9d)', () => {
  it('inactive -> retired, whether or not it ever closed anything', () => {
    expect(deriveStrategyLifecycle({ is_active: false })).toBe('retired')
    expect(deriveStrategyLifecycle({ is_active: false, last_outcome_at: '2026-09-01T00:00:00Z' })).toBe('retired')
  })
  it('active with a closed outcome -> active', () => {
    expect(deriveStrategyLifecycle({ is_active: true, last_outcome_at: '2026-10-02T00:00:00Z' })).toBe('active')
  })
  it('active that has never closed -> trial', () => {
    expect(deriveStrategyLifecycle({ is_active: true })).toBe('trial')
    expect(deriveStrategyLifecycle({ is_active: true, last_outcome_at: null })).toBe('trial')
  })
})

describe('isArchivedSearchVariant', () => {
  it('only a retired search_* clone is archived', () => {
    expect(isArchivedSearchVariant('search_mcap_first_seen_sl_30_tp150_h48', 'retired')).toBe(true)
    expect(isArchivedSearchVariant('search_gmgn_x', 'retired')).toBe(true)
    expect(isArchivedSearchVariant('search_signals_x', 'retired')).toBe(true)
  })
  it('a live search experiment is not archived', () => {
    expect(isArchivedSearchVariant('search_mcap_first_seen_sl_30_tp200_h48', 'trial')).toBe(false)
    expect(isArchivedSearchVariant('search_mcap_first_seen_sl_30_tp200_h48', 'active')).toBe(false)
  })
  it('a retired canonical strategy is retired but stays in the main grid', () => {
    expect(isArchivedSearchVariant('mcap_enter_first_seen', 'retired')).toBe(false)
    expect(isArchivedSearchVariant('signals_default', 'retired')).toBe(false)
  })
})

describe('partitionByLifecycle', () => {
  const rows = [
    { id: 'mcap_enter_first_seen', is_active: true },
    { id: 'mcap_enter_at_80', is_active: false },
    { id: 'search_mcap_first_seen_sl_30_tp150_h48', is_active: false },
    { id: 'search_mcap_first_seen_sl_30_tp200_h48', is_active: true },
    { id: 'search_mcap_first_seen_sl_30_tp300_h48', is_active: false },
  ]
  const outcomes = { mcap_enter_first_seen: '2026-10-02T00:00:00Z' }

  it('folds retired search variants away and keeps everything else, in order', () => {
    const { live, archived } = partitionByLifecycle(rows, outcomes)
    expect(archived.map((a) => a.strategy.id)).toEqual([
      'search_mcap_first_seen_sl_30_tp150_h48',
      'search_mcap_first_seen_sl_30_tp300_h48',
    ])
    expect(archived.every((a) => a.lifecycle === 'retired')).toBe(true)
    expect(live.map((l) => [l.strategy.id, l.lifecycle])).toEqual([
      ['mcap_enter_first_seen', 'active'],
      ['mcap_enter_at_80', 'retired'],
      ['search_mcap_first_seen_sl_30_tp200_h48', 'trial'],
    ])
  })

  it('loses nothing: archived + live is exactly the input', () => {
    const { live, archived } = partitionByLifecycle(rows, outcomes)
    expect([...live.map((l) => l.strategy.id), ...archived.map((a) => a.strategy.id)].sort()).toEqual(
      rows.map((r) => r.id).sort(),
    )
  })

  it('without the outcomes lookup it still retires, and says nothing about trial/active', () => {
    const { live, archived } = partitionByLifecycle(rows, null)
    expect(archived).toHaveLength(2)
    expect(live.find((l) => l.strategy.id === 'mcap_enter_first_seen')!.lifecycle).toBeNull()
    expect(live.find((l) => l.strategy.id === 'mcap_enter_at_80')!.lifecycle).toBe('retired')
  })

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(rows))
    partitionByLifecycle(rows, outcomes)
    expect(rows).toEqual(copy)
  })
})
