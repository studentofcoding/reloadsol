import type { Address, Hex, Log, PublicClient } from 'viem'
import type { GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function topicAddress(topic: string | undefined): string | null {
  if (!topic || topic.length < 42) return null
  return `0x${topic.slice(-40)}`.toLowerCase()
}

/** Sum ERC20 Transfer amounts of `token` received by `recipient`. */
export function erc20ReceivedFromLogs(
  logs: readonly Pick<Log, 'address' | 'topics' | 'data'>[],
  token: string,
  recipient: string,
): bigint {
  const tokenLc = token.toLowerCase()
  const toLc = recipient.toLowerCase()
  let total = BigInt(0)
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenLc) continue
    if ((log.topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
    if (topicAddress(log.topics[2]) !== toLc) continue
    try {
      total += BigInt(log.data)
    } catch {
      /* skip malformed */
    }
  }
  return total
}

/**
 * After a confirmed RH swap hash: require a successful receipt, then set
 * `estOut` from Transfer logs (fallback: Kyber quoted amountOut).
 */
export async function fillConfirmedRhLegAmounts(params: {
  publicClient: PublicClient
  account: Address
  hash?: string
  results: GmgnBulkLegResult[]
  quotedOutByToken: Record<string, string | undefined>
  /** Buy: each leg's tokenAddress. Sell: quote ERC20 (WETH if native ETH). */
  receiveTokenFor: (leg: GmgnBulkLegResult) => string | null
}): Promise<GmgnBulkLegResult[]> {
  const { publicClient, account, hash, results, quotedOutByToken } = params
  if (!hash || !hash.startsWith('0x')) {
    return results.map((r) => attachQuoted(r, quotedOutByToken))
  }

  let logs: readonly Pick<Log, 'address' | 'topics' | 'data'>[] = []
  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: hash as Hex,
    })
    if (receipt.status !== 'success') {
      return results.map((r) =>
        r.success
          ? {
              ...r,
              success: false,
              status: 'failed',
              error: `Transaction reverted: ${hash}`,
            }
          : r,
      )
    }
    logs = receipt.logs
  } catch {
    return results.map((r) => attachQuoted(r, quotedOutByToken))
  }

  return results.map((r) => {
    if (!r.success) return r
    const receive = params.receiveTokenFor(r)
    const fromLogs =
      receive != null ? erc20ReceivedFromLogs(logs, receive, account) : BigInt(0)
    const quoted = quotedOutByToken[r.tokenAddress.toLowerCase()]
    const estOut = fromLogs > BigInt(0) ? fromLogs.toString() : quoted
    return {
      ...r,
      status: 'confirmed',
      ...(estOut ? { estOut } : {}),
    }
  })
}

function attachQuoted(
  r: GmgnBulkLegResult,
  quotedOutByToken: Record<string, string | undefined>,
): GmgnBulkLegResult {
  if (!r.success) return r
  const quoted = quotedOutByToken[r.tokenAddress.toLowerCase()]
  return quoted ? { ...r, estOut: r.estOut ?? quoted } : r
}
