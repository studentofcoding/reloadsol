import type { Address } from 'viem'

export const RH_CHAIN_ID = 4663 as const
export type SupportedChainId = typeof RH_CHAIN_ID
export type ProtocolVersion = 'v3' | 'v4'

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address

export const CHAINS = {
  [RH_CHAIN_ID]: {
    id: RH_CHAIN_ID,
    name: 'Robinhood',
    nativeSymbol: 'ETH',
    wrappedSymbol: 'WETH',
    dexscreenerSlug: 'robinhood',
    explorer: 'https://robinhoodchain.blockscout.com',
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
    npm: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address,
    swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Address,
    wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
    usdc: undefined as Address | undefined,
    usdt: undefined as Address | undefined,
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,
    v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address,
    v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address,
  },
} as const

export const DEFAULT_WIDTH_PERCENT = 20
export const DEFAULT_BALANCE_PERCENT = 50

export function depositAssets(): { address: Address; symbol: string }[] {
  const chain = CHAINS[RH_CHAIN_ID]
  return [
    { address: chain.wrapped, symbol: chain.wrappedSymbol },
    { address: chain.usdg, symbol: 'USDG' },
  ]
}

export function txUrl(chainId: SupportedChainId, hash: string): string {
  return `${CHAINS[chainId].explorer}/tx/${hash}`
}
