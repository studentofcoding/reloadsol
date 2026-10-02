import { describe, expect, it } from 'vitest'
import { resolveBulkPrepareLane } from '@/utils/swap-executor'
import { TOKENS } from '@/utils/solana'

const A = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'
const B = 'BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy'

/**
 * The lane has to follow the pair, not the batch.
 *
 * Measured on two live token→token sells, 2026-10-02: Raptor built both and **Raptor's own program rejected
 * both** — `Custom 6006 TotalAmountsMustBeEqualToAmountIn`, `raptor-v1/common_swap.rs:897` — while Jupiter
 * built the same pair clean (CU 159,976 against Raptor's reverting 58,445). Dropping every leg is a safe
 * failure but not a working batch, so those pairs must never be built on Raptor.
 */
describe('resolveBulkPrepareLane', () => {
  it('sends a leg that touches a verified mint to Raptor', () => {
    expect(resolveBulkPrepareLane(TOKENS.SOL, A)).toBe('raptor')
    expect(resolveBulkPrepareLane(A, TOKENS.SOL)).toBe('raptor')
    expect(resolveBulkPrepareLane(TOKENS.USDC, A)).toBe('raptor')
    expect(resolveBulkPrepareLane(A, TOKENS.USDT)).toBe('raptor')
  })

  it('sends token->token to the keyed lane — Raptor cannot build those', () => {
    expect(resolveBulkPrepareLane(A, B)).toBe('venued')
  })

  it('is symmetric — the rule reads both sides, not just the input', () => {
    expect(resolveBulkPrepareLane(A, B)).toBe(resolveBulkPrepareLane(B, A))
  })
})
