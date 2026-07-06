import { Connection, PublicKey } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { TOKENS } from '@/utils/solana'
import { createRpcConnection } from '@/utils/rpc-urls'
import { fetchRaptorQuoteDirect } from '@/utils/solanatracker-raptor'
import {
  createSignerFromKeypair,
  createTradeExecutor,
  loadTradingKeypair,
} from '@/utils/trade-executors'

export const MCAP_LIVE_STRATEGY_ID = 'mcap_enter_first_seen'
export const MCAP_DEFAULT_SLIPPAGE_BPS = 300
export const RAPTOR_OUTPUT_AMOUNT_RAW_KEY = 'raptor_output_amount_raw'

export function isMcapLiveTradingAvailable(): boolean {
  return (
    process.env.MCAP_LIVE_TRADING_ENABLED === 'true' &&
    !!process.env.TRADING_KEYPAIR_JSON?.trim()
  )
}

export function isMcapLiveStrategyAllowed(strategyId: string): boolean {
  return strategyId === MCAP_LIVE_STRATEGY_ID
}

export function getMcapLiveWallet(): string {
  const override = process.env.MCAP_TRACKER_LIVE_WALLET?.trim()
  if (override) return override
  return loadTradingKeypair().publicKey.toBase58()
}

export function resolveMcapSlippageBps(configSlippage?: number): number {
  if (
    typeof configSlippage === 'number' &&
    Number.isFinite(configSlippage) &&
    configSlippage > 0
  ) {
    return Math.round(configSlippage)
  }
  return MCAP_DEFAULT_SLIPPAGE_BPS
}

function getMcapRaptorConnection(): Connection {
  return createRpcConnection()
}

function getMcapRaptorExecutor(connection = getMcapRaptorConnection()) {
  const keypair = loadTradingKeypair()
  const signer = createSignerFromKeypair(keypair)
  return {
    connection,
    keypair,
    executor: createTradeExecutor(false, connection, signer),
  }
}

async function rawAmountToUi(
  connection: Connection,
  mint: string,
  rawAmount: string,
): Promise<number> {
  const mintInfo = await getMint(connection, new PublicKey(mint))
  return Number(rawAmount) / 10 ** mintInfo.decimals
}

export async function quoteMcapRaptorBuy(
  mint: string,
  solAmount: number,
  slippageBps = MCAP_DEFAULT_SLIPPAGE_BPS,
) {
  const lamports = Math.floor(solAmount * 1e9)
  return fetchRaptorQuoteDirect(TOKENS.SOL, mint, String(lamports), slippageBps)
}

export type McapRaptorBuyResult = {
  signature: string
  outputAmountRaw: string
  tokenAmountUi: number
  solSpent: number
}

export async function executeMcapRaptorBuy(
  mint: string,
  solAmount: number,
  slippageBps = MCAP_DEFAULT_SLIPPAGE_BPS,
  symbol?: string | null,
): Promise<McapRaptorBuyResult> {
  const { connection, keypair, executor } = getMcapRaptorExecutor()
  const lamports = Math.floor(solAmount * 1e9)
  const result = await executor.executeBuy({
    tokenAddress: mint,
    tokenSymbol: symbol ?? null,
    inputMint: TOKENS.SOL,
    outputMint: mint,
    amount: lamports,
    slippageBps,
    userPublicKey: keypair.publicKey.toBase58(),
    priorityFee: 30_000,
  })

  if (!result.success || !result.signature) {
    throw new Error(result.error ?? 'Raptor buy failed')
  }

  const outputAmountRaw = result.outputAmount || '0'
  const tokenAmountUi = await rawAmountToUi(connection, mint, outputAmountRaw)

  return {
    signature: result.signature,
    outputAmountRaw,
    tokenAmountUi,
    solSpent: solAmount,
  }
}

export type McapRaptorSellResult = {
  signature: string
  solReceived: number
  inputAmountRaw: string
}

export async function executeMcapRaptorSell(
  mint: string,
  amountRaw: string,
  slippageBps = MCAP_DEFAULT_SLIPPAGE_BPS,
  symbol?: string | null,
): Promise<McapRaptorSellResult> {
  const { connection, keypair, executor } = getMcapRaptorExecutor()
  const amount = BigInt(amountRaw)
  if (amount <= 0n) {
    throw new Error('Sell amount must be positive')
  }

  const result = await executor.executeSell({
    tokenAddress: mint,
    tokenSymbol: symbol ?? null,
    inputMint: mint,
    outputMint: TOKENS.SOL,
    amount: Number(amount),
    slippageBps,
    userPublicKey: keypair.publicKey.toBase58(),
    priorityFee: 30_000,
  })

  if (!result.success || !result.signature) {
    throw new Error(result.error ?? 'Raptor sell failed')
  }

  const solReceived = Number(result.outputAmount || 0) / 1e9
  return {
    signature: result.signature,
    solReceived,
    inputAmountRaw: amountRaw,
  }
}

export async function fetchTokenBalanceRaw(
  wallet: string,
  mint: string,
  connection = getMcapRaptorConnection(),
): Promise<string> {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(wallet),
    { mint: new PublicKey(mint) },
  )

  let total = 0n
  for (const account of accounts.value) {
    const parsed = account.account.data.parsed
    if (parsed?.type !== 'account') continue
    const amount = parsed.info?.tokenAmount?.amount
    if (typeof amount === 'string') {
      total += BigInt(amount)
    }
  }

  return total.toString()
}
