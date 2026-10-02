import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryOne: vi.fn(async () => null),
}))
vi.mock('@/utils/rug-list/db', () => ({
  addRugEntry: vi.fn(async () => ({ id: 'entry-1' })),
  removeRugEntry: vi.fn(async () => undefined),
  getRugList: vi.fn(async () => []),
  isTokenRugged: vi.fn(async () => false),
}))
vi.mock('@/utils/dlmm/db', () => ({ removePotentialEntry: vi.fn(async () => undefined) }))
vi.mock('@/strategies/signal-ohlc-labels', () => ({
  captureSignalOhlcLabel: vi.fn(async () => undefined),
}))
vi.mock('@/utils/dev-reputation-data', () => ({
  resolveCreatorAddress: vi.fn(async () => null),
}))
vi.mock('@/strategies/risk-store', () => ({
  recordUserRug: vi.fn(async () => 1),
  clearUserRug: vi.fn(async () => 0),
}))

import { queryOne } from '@/utils/db'
import { resolveCreatorAddress } from '@/utils/dev-reputation-data'
import { clearUserRug, recordUserRug } from '@/strategies/risk-store'
import { markTokenRug, unmarkTokenRug } from './service'

const mockQueryOne = vi.mocked(queryOne)
const mockResolveCreator = vi.mocked(resolveCreatorAddress)
const mockRecord = vi.mocked(recordUserRug)
const mockClear = vi.mocked(clearUserRug)

beforeEach(() => {
  mockQueryOne.mockReset()
  mockQueryOne.mockResolvedValue(null)
  mockResolveCreator.mockReset()
  mockResolveCreator.mockResolvedValue(null)
  mockRecord.mockClear()
  mockClear.mockClear()
})

describe('user rug attribution', () => {
  it('counts a user label against the dev stored on the risk row', async () => {
    mockQueryOne.mockResolvedValue({ creator_address: 'DEV_STORED' })
    await markTokenRug({ tokenAddress: 'MINT1', tokenSymbol: 'AAA', source: 'live' })
    expect(mockRecord).toHaveBeenCalledTimes(1)
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      creatorAddress: 'DEV_STORED',
      tokenAddress: 'MINT1',
      symbol: 'AAA',
      source: 'live',
    })
  })

  it('falls back to the resolver when the risk row has no creator', async () => {
    mockResolveCreator.mockResolvedValue('DEV_JUPITER')
    await markTokenRug({ tokenAddress: 'MINT2', source: 'signals-label' })
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      creatorAddress: 'DEV_JUPITER',
      source: 'signals-label',
    })
  })

  it('does not count our own rules as user signals', async () => {
    mockQueryOne.mockResolvedValue({ creator_address: 'DEV_STORED' })
    await markTokenRug({ tokenAddress: 'MINT3', source: 'concentration' })
    await markTokenRug({ tokenAddress: 'MINT4', source: 'gmgn-radar' })
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('skips the count when no creator can be resolved', async () => {
    await markTokenRug({ tokenAddress: 'MINT5', source: 'board' })
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('removes the entry on unmark, whatever surface did it', async () => {
    mockQueryOne.mockResolvedValue({ creator_address: 'DEV_STORED' })
    await unmarkTokenRug('MINT1', 'sol')
    expect(mockClear).toHaveBeenCalledWith(
      expect.objectContaining({ creatorAddress: 'DEV_STORED', tokenAddress: 'MINT1' }),
    )
  })

  it('never lets attribution break the label write', async () => {
    mockQueryOne.mockResolvedValue({ creator_address: 'DEV_STORED' })
    mockRecord.mockRejectedValueOnce(new Error('db down'))
    await expect(
      markTokenRug({ tokenAddress: 'MINT6', source: 'live' }),
    ).resolves.toBeDefined()
  })
})
