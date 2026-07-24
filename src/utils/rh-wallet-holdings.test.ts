import { describe, expect, it } from 'vitest'
import {
  fetchBlockscoutErc20Tokens,
  normalizeBlockscoutErc20,
  normalizeGmgnHolding,
  normalizeSubscribeWallet,
  sortRhTokensByUsd,
  walletsMatch,
} from './rh-wallet-holdings'

/** RH Parent sample wallet (checksummed) — live Blockscout has ERC-20s. */
const RH_PARENT_WALLET = '0x795b5c0c89fC5D3b0De6c04141C3F1b6C340603D'
const RH_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

describe('normalizeGmgnHolding', () => {
  it('reads nested token.address + usd_value', () => {
    const t = normalizeGmgnHolding({
      balance: '12.5',
      usd_value: 40,
      token: {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
        symbol: 'FOO',
        name: 'Foo',
        decimals: 18,
        logo: 'https://example.com/foo.png',
      },
    })
    expect(t?.mintAddress).toBe('0xabcdef0123456789abcdef0123456789abcdef01')
    expect(t?.symbol).toBe('FOO')
    expect(t?.uiAmount).toBe(12.5)
    expect(t?.usdValue).toBe(40)
    expect(t?.isNFT).toBe(false)
  })

  it('skips NFT-like zero-decimal unit balances', () => {
    expect(
      normalizeGmgnHolding({
        balance: 1,
        token: {
          address: '0xabcdef0123456789abcdef0123456789abcdef01',
          decimals: 0,
          total_supply: 1,
          symbol: 'NFT',
        },
      }),
    ).toBeNull()
  })
})

describe('normalizeBlockscoutErc20', () => {
  it('maps ERC-20 value + exchange_rate to usd', () => {
    const t = normalizeBlockscoutErc20({
      value: '1000000000000000000',
      token: {
        address_hash: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
        decimals: '18',
        type: 'ERC-20',
        symbol: 'WETH',
        name: 'WETH',
        exchange_rate: '2000',
        icon_url: 'https://example.com/weth.png',
      },
    })
    expect(t?.mintAddress).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73')
    expect(t?.uiAmount).toBe(1)
    expect(t?.usdValue).toBe(2000)
  })

  it('rejects non ERC-20', () => {
    expect(
      normalizeBlockscoutErc20({
        value: '1',
        token: {
          address_hash: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
          type: 'ERC-721',
          decimals: '0',
          symbol: 'NFT',
        },
      }),
    ).toBeNull()
  })
})

describe('sortRhTokensByUsd', () => {
  it('puts priced tokens before zeros', () => {
    const sorted = sortRhTokensByUsd([
      {
        mintAddress: '0x1',
        balance: 1,
        decimals: 18,
        uiAmount: 1,
        usdValue: 0,
      },
      {
        mintAddress: '0x2',
        balance: 1,
        decimals: 18,
        uiAmount: 1,
        usdValue: 5,
      },
    ])
    expect(sorted.map((t) => t.mintAddress)).toEqual(['0x2', '0x1'])
  })
})

describe('normalizeSubscribeWallet', () => {
  it('lowercases checksummed Parent EVM address', () => {
    expect(normalizeSubscribeWallet(RH_PARENT_WALLET)).toBe(
      RH_PARENT_WALLET.toLowerCase(),
    )
    expect(normalizeSubscribeWallet('not-a-wallet')).toBeNull()
  })

  it('matches EVM wallets case-insensitively', () => {
    expect(
      walletsMatch(RH_PARENT_WALLET, RH_PARENT_WALLET.toLowerCase()),
    ).toBe(true)
  })
})

describe('fetchBlockscoutErc20Tokens (live)', () => {
  it(
    'returns ERC-20 list for Parent wallet including WETH',
    async () => {
      const tokens = await fetchBlockscoutErc20Tokens(RH_PARENT_WALLET)
      expect(tokens.length).toBeGreaterThanOrEqual(1)
      expect(tokens.every((t) => t.uiAmount > 0)).toBe(true)
      expect(tokens.every((t) => !t.isNFT)).toBe(true)
      expect(tokens.some((t) => t.mintAddress === RH_WETH)).toBe(true)
      // Smoke: symbols present for debugging empty UI
      expect(tokens.some((t) => t.symbol === 'WETH')).toBe(true)
    },
    20_000,
  )
})
