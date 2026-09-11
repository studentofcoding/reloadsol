import { describe, expect, it } from 'vitest'
import {
  GMGN_NATIVE_ETH,
  GMGN_RH_USDG,
  GMGN_RH_WETH,
} from '@/utils/gmgn-currencies'
import { TOKENS } from '@/utils/solana'
import { sellOutputMint, sameSellToken } from '@/utils/sell-output-mint'

describe('sellOutputMint', () => {
  it('defaults Solana to wrapped SOL', () => {
    const out = sellOutputMint({ chain: 'sol', preset: 'native' })
    expect(out.outputMint).toBe(TOKENS.SOL)
    expect(out.gmgnOutputToken).toBe(TOKENS.SOL)
    expect(out.kyberOutputToken).toBeUndefined()
    expect(out.symbol).toBe('SOL')
    expect(out.decimals).toBe(9)
  })

  it('uses a valid Solana custom mint as quote outputMint', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const out = sellOutputMint({
      chain: 'sol',
      preset: 'custom',
      customAddress: mint,
    })
    expect(out.outputMint).toBe(mint)
    expect(out.gmgnOutputToken).toBe(mint)
  })

  it('falls back to SOL when custom Solana address is invalid', () => {
    const out = sellOutputMint({
      chain: 'sol',
      preset: 'custom',
      customAddress: '0xnotsolana',
    })
    expect(out.outputMint).toBe(TOKENS.SOL)
  })

  it('maps RH presets to GMGN addresses without a Kyber override', () => {
    const native = sellOutputMint({ chain: 'robinhood', preset: 'native' })
    expect(native.gmgnOutputToken).toBe(GMGN_NATIVE_ETH)
    expect(native.kyberOutputToken).toBeUndefined()
    expect(native.rhQuote).toBe('ETH')
    expect(native.symbol).toBe('ETH')
    expect(sellOutputMint({ chain: 'robinhood', preset: 'USDG' })).toMatchObject({
      gmgnOutputToken: GMGN_RH_USDG,
      rhQuote: 'USDG',
      decimals: 6,
    })
    expect(sellOutputMint({ chain: 'robinhood', preset: 'WETH' })).toMatchObject({
      gmgnOutputToken: GMGN_RH_WETH,
      rhQuote: 'WETH',
    })
  })

  it('passes RH custom CA as Kyber and GMGN tokenOut', () => {
    const ca = '0x1111111111111111111111111111111111111111'
    const out = sellOutputMint({
      chain: 'robinhood',
      preset: 'custom',
      customAddress: ca,
    })
    expect(out.kyberOutputToken).toBe(ca)
    expect(out.gmgnOutputToken).toBe(ca)
    expect(out.outputMint).toBe(ca)
  })

  it('treats same-token legs as equal ignoring case', () => {
    expect(
      sameSellToken(
        '0xAaaaAAaaAaaaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe(true)
    expect(sameSellToken(TOKENS.SOL, GMGN_RH_USDG)).toBe(false)
  })
})
