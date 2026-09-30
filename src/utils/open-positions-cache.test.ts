import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPEN_BAR_CACHE_MAX_AGE_MS,
  clearOpenBarPositionsCache,
  readOpenBarPositionsCache,
  writeOpenBarPositionsCache,
} from './open-positions-cache'
import type { OpenBarPosition } from './open-bar-positions'

const WALLET = '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'
const OTHER = 'OtherWallet1111111111111111111111111111111'
const STORAGE_KEY = 'reloadsol_open_bar_positions_v1'

function position(mint: string, symbol = 'TOK'): OpenBarPosition {
  return {
    mintAddress: mint,
    symbol,
    logoURI: null,
    buyPriceUsd: 0.05,
    balanceRaw: 1_000_000,
    uiAmount: 1000,
    decimals: 6,
  }
}

let store: Record<string, string>

beforeEach(() => {
  store = {}
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('open positions cache', () => {
  it('round-trips positions for a wallet+chain', () => {
    writeOpenBarPositionsCache(WALLET, 'sol', [position('MintA')])
    const read = readOpenBarPositionsCache(WALLET, 'sol')
    expect(read).toHaveLength(1)
    expect(read[0].mintAddress).toBe('MintA')
  })

  it('never answers one chain from another chain entry', () => {
    writeOpenBarPositionsCache(WALLET, 'sol', [position('SolMint')])
    expect(readOpenBarPositionsCache(WALLET, 'robinhood')).toEqual([])
  })

  it('never answers one wallet from another wallet entry', () => {
    writeOpenBarPositionsCache(WALLET, 'sol', [position('SolMint')])
    expect(readOpenBarPositionsCache(OTHER, 'sol')).toEqual([])
  })

  it('ignores an entry older than the max age', () => {
    const stale = new Date(Date.now() - OPEN_BAR_CACHE_MAX_AGE_MS - 1000).toISOString()
    store[STORAGE_KEY] = JSON.stringify({
      [`${WALLET}:sol`]: { positions: [position('MintA')], updatedAt: stale },
    })
    expect(readOpenBarPositionsCache(WALLET, 'sol')).toEqual([])
  })

  it('returns [] rather than throwing on malformed storage', () => {
    store[STORAGE_KEY] = '{not json'
    expect(readOpenBarPositionsCache(WALLET, 'sol')).toEqual([])
    store[STORAGE_KEY] = JSON.stringify({ [`${WALLET}:sol`]: { positions: 'nope' } })
    expect(readOpenBarPositionsCache(WALLET, 'sol')).toEqual([])
  })

  it('clears only the requested wallet+chain', () => {
    writeOpenBarPositionsCache(WALLET, 'sol', [position('SolMint')])
    writeOpenBarPositionsCache(WALLET, 'robinhood', [position('RhMint')])
    clearOpenBarPositionsCache(WALLET, 'sol')
    expect(readOpenBarPositionsCache(WALLET, 'sol')).toEqual([])
    expect(readOpenBarPositionsCache(WALLET, 'robinhood')).toHaveLength(1)
  })

  it('is a no-op without a wallet, and survives an unavailable storage', () => {
    expect(readOpenBarPositionsCache('', 'sol')).toEqual([])
    writeOpenBarPositionsCache('', 'sol', [position('MintA')])
    expect(readOpenBarPositionsCache('', 'sol')).toEqual([])

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
      removeItem: () => {},
    })
    expect(() => writeOpenBarPositionsCache(WALLET, 'sol', [position('MintA')])).not.toThrow()
    expect(readOpenBarPositionsCache(WALLET, 'sol')).toEqual([])
  })
})
