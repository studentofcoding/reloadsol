import { describe, expect, it } from 'vitest'
import { parseBoundWalletsFromUserInfo } from './gmgn-bound-wallets'

describe('parseBoundWalletsFromUserInfo', () => {
  it('reads wallets array with sol + robinhood', () => {
    const parsed = parseBoundWalletsFromUserInfo({
      wallets: [
        {
          chain: 'sol',
          address: 'So11111111111111111111111111111111111111112',
        },
        {
          chain: 'robinhood',
          address: '0xAbCDEF0000000000000000000000000000000001',
        },
      ],
    })
    expect(parsed.sol).toBe('So11111111111111111111111111111111111111112')
    expect(parsed.evm).toBe('0xabcdef0000000000000000000000000000000001')
  })

  it('reads map-shaped info and prefers robinhood over eth', () => {
    const parsed = parseBoundWalletsFromUserInfo({
      sol: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      eth: '0x1111111111111111111111111111111111111111',
      robinhood: { wallet_address: '0x2222222222222222222222222222222222222222' },
    })
    expect(parsed.sol).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
    expect(parsed.evm).toBe('0x2222222222222222222222222222222222222222')
  })
})
