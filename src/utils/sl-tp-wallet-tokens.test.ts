import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchShyft = vi.fn()
const fetchJupiter = vi.fn()
const fetchUserTokens = vi.fn()

vi.mock('@/utils/db', () => ({ query: vi.fn(), queryOne: vi.fn() }))
vi.mock('@/utils/shyft-wallet-cache', () => ({
  fetchShyftAllTokensCached: (...a: unknown[]) => fetchShyft(...a),
}))
vi.mock('@/utils/shyft-wallet', () => ({ mapShyftTokensToUserTokens: vi.fn((t: unknown[]) => t) }))
vi.mock('@/utils/jupiter-portfolio', () => ({
  fetchJupiterPortfolioDirect: (...a: unknown[]) => fetchJupiter(...a),
  mapPortfolioToUserTokens: vi.fn((p: unknown[]) => p),
}))
vi.mock('@/utils/jupiter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/jupiter')>()),
  fetchUserTokens: (...a: unknown[]) => fetchUserTokens(...a),
}))
vi.mock('@/utils/solana', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/solana')>()),
  getConnection: vi.fn(() => ({})),
}))

const REAL = 'So11111111111111111111111111111111111111112'

const { fetchSlTpWalletTokens } = await import('@/utils/sl-tp-tracker')
const { isOnChainWalletAddress } = await import('@/utils/solana-address')

describe('isOnChainWalletAddress', () => {
  it.each(['gmgn-sim', 'mcap-tracker-sim', 'trending-bot-sim-rh', 'signals-strategy-sim', 'social-sim', '', '  '])(
    'rejects sim/placeholder label %j',
    (v) => expect(isOnChainWalletAddress(v)).toBe(false),
  )
  it('rejects null/undefined', () => {
    expect(isOnChainWalletAddress(null)).toBe(false)
    expect(isOnChainWalletAddress(undefined)).toBe(false)
  })
  it('accepts a real base58 wallet', () => {
    expect(isOnChainWalletAddress(REAL)).toBe(true)
  })
})

describe('fetchSlTpWalletTokens', () => {
  beforeEach(() => {
    fetchShyft.mockReset()
    fetchJupiter.mockReset()
    fetchUserTokens.mockReset()
  })

  it('makes no Shyft/Jupiter/RPC call for a sim wallet label', async () => {
    for (const w of ['gmgn-sim', 'mcap-tracker-sim', 'trending-bot-sim-rh']) {
      await expect(fetchSlTpWalletTokens(w)).resolves.toEqual([])
    }
    expect(fetchShyft).not.toHaveBeenCalled()
    expect(fetchJupiter).not.toHaveBeenCalled()
    expect(fetchUserTokens).not.toHaveBeenCalled()
  })

  it('uses Shyft first for a real wallet', async () => {
    fetchShyft.mockResolvedValue({ tokens: [{ mintAddress: 'M', uiAmount: 1 }] })
    await expect(fetchSlTpWalletTokens(REAL)).resolves.toEqual([{ mintAddress: 'M', uiAmount: 1 }])
    expect(fetchJupiter).not.toHaveBeenCalled()
  })

  it('keeps the Shyft → Jupiter → RPC fallback for a real wallet', async () => {
    fetchShyft.mockRejectedValue(new Error('shyft down'))
    fetchJupiter.mockResolvedValue([{ mintAddress: 'J', uiAmount: 2 }])
    await expect(fetchSlTpWalletTokens(REAL)).resolves.toEqual([{ mintAddress: 'J', uiAmount: 2 }])

    fetchJupiter.mockRejectedValue(new Error('jup down'))
    fetchUserTokens.mockResolvedValue([{ mintAddress: 'R', uiAmount: 3 }])
    await expect(fetchSlTpWalletTokens(REAL)).resolves.toEqual([{ mintAddress: 'R', uiAmount: 3 }])
    expect(fetchUserTokens).toHaveBeenCalledTimes(1)
  })
})
