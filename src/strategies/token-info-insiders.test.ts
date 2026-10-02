import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/gmgn-web-extra', () => ({ fetchGmgnWebTokenStat: vi.fn() }))

import { fetchGmgnWebTokenStat } from '@/utils/gmgn-web-extra'
import { withInsidersFromTokenStat } from '@/strategies/token-info-insiders'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'

const SEC = {
  top_10_holder_rate: 0.2,
  sniper_hold_rate: 0.01,
  bundler_trader_amount_rate: 0.03,
  renounced_mint: true,
  renounced_freeze_account: true,
}
const statOf = (ratPct: number | null) =>
  ({ ratPct, bundlerPct: null, entrapmentPct: null, botDegenPct: null, privateVaultPct: null, top10Pct: null, creatorCreatedCount: null }) as never

describe('withInsidersFromTokenStat', () => {
  beforeEach(() => vi.mocked(fetchGmgnWebTokenStat).mockReset())

  it('fills the insiders tile from token_stat rat share', async () => {
    vi.mocked(fetchGmgnWebTokenStat).mockResolvedValue(statOf(4.5))
    const sec = await withInsidersFromTokenStat('M', {}, SEC)
    expect(buildGmgnTokenSnapshot({}, sec).insidersHoldPct).toBeCloseTo(4.5, 5)
  })

  it('a real 0% rat share is kept as 0', async () => {
    vi.mocked(fetchGmgnWebTokenStat).mockResolvedValue(statOf(0))
    const sec = await withInsidersFromTokenStat('M', {}, SEC)
    expect(buildGmgnTokenSnapshot({}, sec).insidersHoldPct).toBe(0)
  })

  it('does not call upstream when an insider value already exists', async () => {
    const sec = { ...SEC, suspected_insider_hold_rate: 0.1 }
    expect(await withInsidersFromTokenStat('M', {}, sec)).toBe(sec)
    expect(fetchGmgnWebTokenStat).not.toHaveBeenCalled()
  })

  it('does not call upstream for a panel the gate would refuse', async () => {
    const sec = { renounced_mint: true }
    expect(await withInsidersFromTokenStat('M', {}, sec)).toBe(sec)
    expect(fetchGmgnWebTokenStat).not.toHaveBeenCalled()
  })

  it('stays NULL on a miss or an error (never invented)', async () => {
    vi.mocked(fetchGmgnWebTokenStat).mockResolvedValueOnce(null)
    expect(await withInsidersFromTokenStat('M', {}, SEC)).toBe(SEC)
    vi.mocked(fetchGmgnWebTokenStat).mockResolvedValueOnce(statOf(null))
    expect(await withInsidersFromTokenStat('M', {}, SEC)).toBe(SEC)
    vi.mocked(fetchGmgnWebTokenStat).mockRejectedValueOnce(new Error('x'))
    expect(await withInsidersFromTokenStat('M', {}, SEC)).toBe(SEC)
  })
})
