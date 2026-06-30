import { describe, expect, it, vi } from 'vitest'
import { buildEntryFeatureSnapshot } from './entry-feature-snapshot'

vi.mock('@/utils/db', () => ({
  queryOne: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/utils/jupiter-metadata', () => ({
  fetchTokenMetadataFromJupiter: vi.fn(),
}))
vi.mock('@/utils/mcap-tracker', () => ({
  fetchMcapTrackingRow: vi.fn().mockResolvedValue(null),
}))
vi.mock('./sim-monitor-snapshots', () => ({
  TRACKER_TABLE: 'trending_token_tracker_dev',
  resolveTokenMonitorSnapshot: vi.fn().mockResolvedValue({
    timestamp: '2026-01-01T00:00:00.000Z',
    price_usd: 0.001,
    volume_5m: 5000,
    market_cap: 100_000,
  }),
}))

import { resolveEntrySnapshotInput } from './resolve-entry-snapshot'
import { fetchTokenMetadataFromJupiter } from '@/utils/jupiter-metadata'

describe('resolveEntrySnapshotInput', () => {
  it('uses caller overrides and skips Jupiter when requested', async () => {
    const input = await resolveEntrySnapshotInput('mint123', {
      entryAt: '2026-01-02T12:00:00.000Z',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      entryMcap: 120_000,
      organicScore: 72,
      topHoldersPct: 18,
      volume5m: 9000,
      tokenSymbol: 'TEST',
      skipJupiter: true,
      monitorSnapshots: [],
    })

    expect(fetchTokenMetadataFromJupiter).not.toHaveBeenCalled()
    expect(input.organicScore).toBe(72)
    expect(input.topHoldersPct).toBe(18)

    const features = buildEntryFeatureSnapshot(input)
    expect(features.organic_score).toBe(72)
    expect(features.top_holders_pct).toBe(18)
    expect(features.entry_mcap).toBe(120_000)
    expect(features.token_age_hours).toBe(36)
  })
})
