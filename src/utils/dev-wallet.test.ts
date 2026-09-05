import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_RH_DEV_WALLETS,
  DEFAULT_SOL_DEV_WALLETS,
  clearDevWalletCache,
  isDevWallet,
} from '@/utils/dev-wallet'

const SOL = DEFAULT_SOL_DEV_WALLETS[0]
const RH = DEFAULT_RH_DEV_WALLETS[0]

describe('isDevWallet chain split', () => {
  afterEach(() => {
    clearDevWalletCache()
    delete process.env.NEXT_PUBLIC_DEV_WALLETS
    delete process.env.DEV_WALLETS
  })

  it('matches Sol only on sol, RH deployer only on robinhood', () => {
    expect(isDevWallet(SOL, 'sol')).toBe(true)
    expect(isDevWallet(SOL, 'robinhood')).toBe(false)
    expect(isDevWallet(RH, 'robinhood')).toBe(true)
    expect(isDevWallet(RH.toLowerCase(), 'robinhood')).toBe(true)
    expect(isDevWallet(RH, 'sol')).toBe(false)
  })

  it('without network, each address matches its own list only', () => {
    expect(isDevWallet(SOL)).toBe(true)
    expect(isDevWallet(RH)).toBe(true)
    expect(isDevWallet('9'.repeat(44))).toBe(false)
    expect(isDevWallet('0x1111111111111111111111111111111111111111')).toBe(
      false,
    )
  })

  it('env 0x keys land on RH, base58 on Sol', () => {
    process.env.NEXT_PUBLIC_DEV_WALLETS =
      'EnvSol11111111111111111111111111111111111111,0xAbCDef0123456789ABCDef0123456789ABCDef01'
    clearDevWalletCache()
    expect(
      isDevWallet('EnvSol11111111111111111111111111111111111111', 'sol'),
    ).toBe(true)
    expect(
      isDevWallet('0xabcdef0123456789abcdef0123456789abcdef01', 'robinhood'),
    ).toBe(true)
    expect(
      isDevWallet('EnvSol11111111111111111111111111111111111111', 'robinhood'),
    ).toBe(false)
  })
})
