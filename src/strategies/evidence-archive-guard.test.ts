import { describe, expect, it } from 'vitest'
import { barsPruneFloor, pruneRequiresArchive } from './evidence-archive-guard'
import type { QueryFn } from './evidence-archive'

const NOW = Date.parse('2026-10-04T03:00:00Z')
const q = (doneDays: string[]) =>
  (async () => ({ rows: doneDays.map((day) => ({ day })) })) as unknown as QueryFn

describe('barsPruneFloor', () => {
  it('is off by default', () => {
    expect(pruneRequiresArchive({})).toBe(false)
    expect(pruneRequiresArchive({ OHLC_PRUNE_REQUIRES_ARCHIVE: '1' })).toBe(true)
  })
  it('protects the oldest un-archived complete day', async () => {
    const floor = await barsPruneFloor(q(['2026-10-01', '2026-10-03']), NOW, {})
    expect(floor?.toISOString()).toBe('2026-10-02T00:00:00.000Z')
  })
  it('lets the prune proceed once every eligible day is archived', async () => {
    await expect(barsPruneFloor(q(['2026-10-01', '2026-10-02', '2026-10-03']), NOW, {})).resolves.toBeNull()
  })
  it('keeps everything when the ledger cannot be read', async () => {
    const boom = (async () => {
      throw new Error('db down')
    }) as unknown as QueryFn
    expect((await barsPruneFloor(boom, NOW, {}))?.getTime()).toBe(0)
  })
})
