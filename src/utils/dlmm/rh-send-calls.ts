/**
 * EIP-5792 wallet_sendCalls with sequential sendTransaction fallback.
 * msg.sender stays the user (unlike Multicall3).
 */

import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { getCapabilities, sendCalls, waitForCallsStatus } from 'viem/actions'
import { RH_CHAIN_ID } from '@/utils/dlmm/rh-univ2'

export type RhTxCall = {
  to: Address
  data: Hex
  value?: bigint
  gas?: bigint
}

export function shouldFallbackFromSendCalls(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    msg.includes('denied transaction')
  ) {
    return false
  }
  return (
    msg.includes('wallet_sendcalls') ||
    msg.includes('sendcalls') ||
    msg.includes('method not found') ||
    msg.includes('method not supported') ||
    msg.includes('does not exist') ||
    msg.includes('not supported') ||
    msg.includes('unsupported') ||
    msg.includes('capability') ||
    msg.includes('atomic') ||
    msg.includes('4200')
  )
}

/** True when wallet advertises atomic batch for the active chain (EIP-5792). */
export async function rhWalletSupportsAtomicBatch(params: {
  walletClient: WalletClient
  account: Address
}): Promise<boolean> {
  const { walletClient, account } = params
  try {
    const caps = await getCapabilities(walletClient, { account })
    const chainId = walletClient.chain?.id ?? RH_CHAIN_ID
    const hexKey = `0x${chainId.toString(16)}`
    const byChain = caps as Record<
      string,
      { atomic?: { status?: string } } | undefined
    >
    const status =
      byChain[hexKey]?.atomic?.status ??
      byChain[hexKey.toLowerCase()]?.atomic?.status ??
      byChain[String(chainId)]?.atomic?.status
    return status === 'supported' || status === 'ready'
  } catch {
    return false
  }
}

async function writeCallsSequential(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
}): Promise<{ hash: Hex }> {
  const { publicClient, walletClient, account, calls } = params
  let lastHash: Hex | undefined
  for (const call of calls) {
    lastHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: call.to,
      data: call.data,
      value: call.value ?? BigInt(0),
      ...(call.gas != null ? { gas: call.gas } : {}),
    })
    await publicClient.waitForTransactionReceipt({ hash: lastHash })
  }
  if (!lastHash) throw new Error('No calls to send')
  return { hash: lastHash }
}

/**
 * 1 call → sequential write.
 * 2+ → try wallet_sendCalls only if atomic capability present; else sequential.
 * `hash` is the last real tx hash when receipts exist (not the batch id).
 */
export async function executeRhWalletCalls(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
}): Promise<{ hash: Hex; batched: boolean }> {
  const { publicClient, walletClient, account, calls } = params
  if (calls.length === 0) throw new Error('No calls to send')
  if (calls.length === 1) {
    const { hash } = await writeCallsSequential(params)
    return { hash, batched: false }
  }

  const canBatch = await rhWalletSupportsAtomicBatch({ walletClient, account })
  if (!canBatch) {
    console.warn(
      '[rh-send-calls] wallet lacks atomic batch on this chain — sequential Approve/Swap signs',
    )
    const { hash } = await writeCallsSequential(params)
    return { hash, batched: false }
  }

  try {
    const { id } = await sendCalls(walletClient, {
      account,
      chain: walletClient.chain,
      calls: calls.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value ?? BigInt(0),
        ...(c.gas != null ? { gas: c.gas } : {}),
      })),
    })
    const status = await waitForCallsStatus(walletClient, { id })
    if (status.status !== 'success') {
      throw new Error(`Batch status: ${status.status ?? 'unknown'}`)
    }
    const txHashes =
      status.receipts
        ?.map((r) => r.transactionHash)
        .filter((h): h is Hex => typeof h === 'string' && h.startsWith('0x')) ??
      []
    const hash = txHashes[txHashes.length - 1]
    if (!hash) {
      throw new Error('sendCalls succeeded but returned no tx receipts')
    }
    return { hash, batched: true }
  } catch (error) {
    if (!shouldFallbackFromSendCalls(error)) throw error
    console.warn(
      '[rh-send-calls] sendCalls failed — sequential fallback',
      error instanceof Error ? error.message : error,
    )
    const { hash } = await writeCallsSequential({
      publicClient,
      walletClient,
      account,
      calls,
    })
    return { hash, batched: false }
  }
}
