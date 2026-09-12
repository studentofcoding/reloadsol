import { describe, expect, it } from 'vitest'
import {
  categorizeUserTokens,
  isDustToken,
  isZeroValueToken,
  type UserToken,
} from '@/utils/jupiter'

function token(partial: Partial<UserToken>): UserToken {
  return {
    mintAddress: 'Mint111111111111111111111111111111111111111',
    balance: 1_000_000,
    decimals: 6,
    uiAmount: 1,
    usdValue: 0,
    ...partial,
  }
}

describe('usdPriced categorize gate', () => {
  it('isZeroValueToken is false when usdPriced is false', () => {
    const t = token({ usdValue: 0, usdPriced: false })
    expect(isZeroValueToken(t)).toBe(false)
    expect(isDustToken(t)).toBe(false)
    const { zeroValue, dust, valuable } = categorizeUserTokens([t])
    expect(zeroValue).toHaveLength(0)
    expect(dust).toHaveLength(0)
    expect(valuable).toHaveLength(0)
  })

  it('priced dust still lands in dust', () => {
    const t = token({ usdValue: 0.05, usdPriced: true })
    expect(isDustToken(t)).toBe(true)
    expect(categorizeUserTokens([t]).dust).toEqual([t])
  })
})
