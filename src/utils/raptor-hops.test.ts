import { describe, expect, it } from 'vitest'
import { TOKENS } from '@/utils/solana'
import {
  RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT,
  RAPTOR_VERIFIED_QUOTE_MINTS,
  getRaptorTokenTokenHops,
  isVerifiedQuoteMint,
  resolveRaptorHops,
} from '@/utils/raptor-hops'

const DEW = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'
const BPX = 'BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy'
const VERIFIED = { RAPTOR_MAX_HOPS: '1' }

/**
 * Measured on prod 2026-10-01: at maxHops=1 a token→token quote returns
 * `500 "Failed to get quote: No direct route found and maxHops=1"`; at 2 and 3 it returns 200. A route
 * through SOL/USDC/USDT returns 200 at 1. These tests pin exactly that split.
 */
describe('resolveRaptorHops', () => {
  it('keeps a single hop for any route touching a verified mint', () => {
    expect(resolveRaptorHops(TOKENS.SOL, DEW, { env: VERIFIED })).toBe(1)
    expect(resolveRaptorHops(DEW, TOKENS.SOL, { env: VERIFIED })).toBe(1)
    expect(resolveRaptorHops(TOKENS.USDC, DEW, { env: VERIFIED })).toBe(1)
    expect(resolveRaptorHops(DEW, TOKENS.USDC, { env: VERIFIED })).toBe(1)
    expect(resolveRaptorHops(TOKENS.USDT, DEW, { env: VERIFIED })).toBe(1)
    expect(resolveRaptorHops(DEW, TOKENS.USDT, { env: VERIFIED })).toBe(1)
  })

  it('widens a token→token pair, which has no direct pool', () => {
    expect(resolveRaptorHops(DEW, BPX, { env: VERIFIED })).toBe(RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT)
    expect(resolveRaptorHops(BPX, DEW, { env: VERIFIED })).toBe(RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT)
  })

  it('lets an explicit caller override win — including the arb path', () => {
    expect(resolveRaptorHops(DEW, BPX, { requested: 2, env: VERIFIED })).toBe(2)
    expect(resolveRaptorHops(TOKENS.SOL, DEW, { requested: 3, env: VERIFIED })).toBe(3)
    expect(resolveRaptorHops(DEW, BPX, { requested: null, env: VERIFIED })).toBe(
      RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT,
    )
  })

  it('honours a raised global ceiling without lowering the token→token floor', () => {
    // RAPTOR_MAX_HOPS raises the ceiling for a verified-mint leg...
    expect(resolveRaptorHops(TOKENS.SOL, DEW, { env: { RAPTOR_MAX_HOPS: '2' } })).toBe(2)
    // ...but it must not *lower* a token→token query below the floor, or the pair breaks again.
    expect(resolveRaptorHops(DEW, BPX, { env: { RAPTOR_MAX_HOPS: '2' } })).toBe(
      RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT,
    )
    // a global ceiling above the floor simply wins
    expect(resolveRaptorHops(DEW, BPX, { env: { RAPTOR_MAX_HOPS: '4' } })).toBe(4)
  })
})

describe('getRaptorTokenTokenHops', () => {
  it('defaults, reads env, ignores junk, and can be set back to 1', () => {
    expect(getRaptorTokenTokenHops({})).toBe(RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT)
    expect(getRaptorTokenTokenHops({ RAPTOR_TOKEN_TOKEN_HOPS: '2' })).toBe(2)
    expect(getRaptorTokenTokenHops({ RAPTOR_TOKEN_TOKEN_HOPS: '0' })).toBe(
      RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT,
    )
    expect(getRaptorTokenTokenHops({ RAPTOR_TOKEN_TOKEN_HOPS: 'junk' })).toBe(
      RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT,
    )
    // the escape hatch back to the old behaviour
    expect(resolveRaptorHops(DEW, BPX, { env: { RAPTOR_TOKEN_TOKEN_HOPS: '1' } })).toBe(1)
  })
})

describe('isVerifiedQuoteMint', () => {
  it('is exactly SOL, USDC and USDT', () => {
    expect([...RAPTOR_VERIFIED_QUOTE_MINTS].sort()).toEqual(
      [TOKENS.SOL, TOKENS.USDC, TOKENS.USDT].sort(),
    )
    expect(isVerifiedQuoteMint(DEW)).toBe(false)
  })
})

