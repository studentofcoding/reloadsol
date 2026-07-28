/** Map LP Terminal / explicit proto to CLMM mint protocol. */
export function resolvePoolMintProtocol(
  poolAddress: string,
  explicit?: string | null,
): 'v3' | 'v4' {
  const e = (explicit ?? '').toLowerCase()
  if (e === 'v4' || e === 'univ4') return 'v4'
  if (e === 'v3' || e === 'univ3') return 'v3'
  // Uniswap v4 poolId is bytes32; v3 pool contracts are 20-byte addresses.
  if (/^0x[0-9a-fA-F]{64}$/.test(poolAddress.trim())) return 'v4'
  return 'v3'
}

/** After a v3 "already empty" close, try v4 once (mis-tagged marks). */
export function nextCloseProtocolAfterEmpty(
  attempted: 'v3' | 'v4',
): 'v4' | null {
  return attempted === 'v3' ? 'v4' : null
}
