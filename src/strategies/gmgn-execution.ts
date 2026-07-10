import { gmgnCliRaw, GmgnCliError } from '@/utils/gmgn-cli'

export type GmgnLiveSwapParams = {
  chain: 'sol' | 'bsc' | 'base' | 'eth'
  inputToken: string
  outputToken: string
  amount: string
  slippage?: number
  autoSlippage?: boolean
}

export type GmgnLiveSwapResult = {
  orderId?: string
  txHash?: string
  raw: unknown
}

/**
 * Live swap via gmgn-cli — NOT enabled in v1 (sim_only strategies).
 * Requires GMGN_PRIVATE_KEY on the server; wallet must match API key binding.
 */
export async function executeGmgnLiveSwap(
  params: GmgnLiveSwapParams,
): Promise<GmgnLiveSwapResult> {
  if (!process.env.GMGN_PRIVATE_KEY?.trim()) {
    throw new Error('GMGN_PRIVATE_KEY not set — live GMGN swap disabled')
  }

  const args = [
    'swap',
    '--chain',
    params.chain,
    '--input-token',
    params.inputToken,
    '--output-token',
    params.outputToken,
    '--amount',
    params.amount,
    '--raw',
  ]

  if (params.autoSlippage) {
    args.push('--auto-slippage')
  } else if (params.slippage != null) {
    args.push('--slippage', String(params.slippage))
  }

  try {
    const raw = await gmgnCliRaw(args, 60_000)
    const obj =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    return {
      orderId: typeof obj.order_id === 'string' ? obj.order_id : undefined,
      txHash:
        typeof obj.tx_hash === 'string'
          ? obj.tx_hash
          : typeof obj.transaction_hash === 'string'
            ? obj.transaction_hash
            : undefined,
      raw,
    }
  } catch (error) {
    if (error instanceof GmgnCliError) throw error
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

export function isGmgnLiveExecutionAvailable(): boolean {
  return Boolean(process.env.GMGN_PRIVATE_KEY?.trim() && process.env.GMGN_API_KEY?.trim())
}
