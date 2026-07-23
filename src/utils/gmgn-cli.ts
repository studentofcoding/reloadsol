import { execFile } from 'child_process'
import { promisify } from 'util'
import * as gmgnApi from './gmgn-api'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 15_000
const SOL_NATIVE = 'So11111111111111111111111111111111111111112'

export class GmgnCliError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly resetAt?: number,
  ) {
    super(message)
    this.name = 'GmgnCliError'
  }
}

export { GmgnApiError } from './gmgn-api'

export type GmgnTrackRow = {
  transaction_hash?: string
  maker?: string
  base_address?: string
  amount_usd?: number
  price_usd?: number
  timestamp?: number
  side?: string
  is_open_or_close?: number
  base_token?: { symbol?: string; launchpad?: string }
  maker_info?: { tags?: string[]; name?: string; twitter_username?: string }
}

export type GmgnTrackResponse = { list?: GmgnTrackRow[] }

export type { GmgnMarketRankRow, MarketTrendingParams } from './gmgn-api'
export type { GmgnTokenTraderRow, TokenTradersParams, GmgnWalletStats } from './gmgn-api'

// GMGN_TRANSPORT=cli is ignored — facades always use HTTP (gmgn-api).

function getCliBin(): string {
  return process.env.GMGN_CLI_BIN?.trim() || 'gmgn-cli'
}

function getCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.env.GMGN_API_KEY) {
    env.GMGN_API_KEY = process.env.GMGN_API_KEY
  }
  return env
}

function parseRateLimitReset(stderr: string, stdout: string): number | undefined {
  const combined = `${stdout}\n${stderr}`
  const resetAtMatch = combined.match(/"reset_at"\s*:\s*(\d+)/)
  if (resetAtMatch) return Number(resetAtMatch[1])
  const headerMatch = combined.match(/X-RateLimit-Reset[:\s]+(\d+)/i)
  if (headerMatch) return Number(headerMatch[1])
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Live swap / order stub only — read facades never spawn CLI. */
export async function gmgnCliRaw(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const bin = getCliBin()
  const maxAttempts = 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        env: getCliEnv(),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      })

      const trimmed = stdout.trim()
      if (!trimmed) {
        throw new GmgnCliError(stderr.trim() || 'Empty gmgn-cli output')
      }

      try {
        return JSON.parse(trimmed) as unknown
      } catch {
        throw new GmgnCliError(`Invalid JSON from gmgn-cli: ${trimmed.slice(0, 200)}`)
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      const stdout = err.stdout ?? ''
      const stderr = err.stderr ?? ''
      const message = `${stderr}\n${stdout}`.trim() || err.message
      const isRateLimit =
        message.includes('429') ||
        message.includes('RATE_LIMIT') ||
        message.includes('rate limit')

      if (isRateLimit && attempt < maxAttempts) {
        const resetAt = parseRateLimitReset(stderr, stdout)
        const waitMs = resetAt
          ? Math.min(Math.max(resetAt * 1000 - Date.now(), 1000), 30_000)
          : 3000
        await sleep(waitMs)
        continue
      }

      if (isRateLimit) {
        throw new GmgnCliError(message, 'RATE_LIMIT', parseRateLimitReset(stderr, stdout))
      }

      throw new GmgnCliError(message)
    }
  }

  throw new GmgnCliError('gmgn-cli failed after retries')
}

export async function trackSmartMoney(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  return gmgnApi.trackSmartMoney(params)
}

export async function trackKol(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  return gmgnApi.trackKol(params)
}

export async function tokenInfo(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  return gmgnApi.tokenInfo(params)
}

export async function tokenSecurity(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  return gmgnApi.tokenSecurity(params)
}

export async function marketTrending(
  params: gmgnApi.MarketTrendingParams,
): Promise<gmgnApi.GmgnMarketRankRow[]> {
  return gmgnApi.marketTrending(params)
}

export async function tokenTraders(
  params: gmgnApi.TokenTradersParams,
): Promise<gmgnApi.GmgnTokenTraderRow[]> {
  return gmgnApi.tokenTraders(params)
}

export async function walletStats(params: {
  chain: string
  wallet: string
  period?: '7d' | '30d'
}): Promise<gmgnApi.GmgnWalletStats> {
  return gmgnApi.walletStats(params)
}

export async function trackFollowWallet(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
  wallet?: string
  minAmountUsd?: number
  maxAmountUsd?: number
}): Promise<GmgnTrackRow[]> {
  return gmgnApi.trackFollowWallet(params)
}

export function isSolMemeTokenAddress(address: string | undefined): boolean {
  if (!address || address === SOL_NATIVE) return false
  if (address.length < 32 || address.length > 44) return false
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
}

const EVM_ZERO = '0x0000000000000000000000000000000000000000'

/** Robinhood / EVM-style token address. */
export function isEvmTokenAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.trim()
  if (a.toLowerCase() === EVM_ZERO) return false
  return /^0x[a-fA-F0-9]{40}$/.test(a)
}

export function isGmgnTokenAddress(
  chain: string,
  address: string | undefined,
): boolean {
  if (chain === 'robinhood' || chain === 'bsc' || chain === 'base' || chain === 'eth') {
    return isEvmTokenAddress(address)
  }
  return isSolMemeTokenAddress(address)
}

export function normalizeTrackRows(
  rows: GmgnTrackRow[],
  source: 'smartmoney' | 'kol',
): Array<{
  tokenAddress: string
  symbol: string
  walletAddress: string
  tradeUsd: number
  tradeAt: Date
  source: 'smartmoney' | 'kol'
  walletTags: string[]
}> {
  const out: Array<{
    tokenAddress: string
    symbol: string
    walletAddress: string
    tradeUsd: number
    tradeAt: Date
    source: 'smartmoney' | 'kol'
    walletTags: string[]
  }> = []

  for (const row of rows) {
    if (row.side && row.side !== 'buy') continue
    if (!isSolMemeTokenAddress(row.base_address)) continue
    const tradeUsd = typeof row.amount_usd === 'number' ? row.amount_usd : 0
    const ts =
      typeof row.timestamp === 'number' && row.timestamp > 0
        ? row.timestamp
        : Math.floor(Date.now() / 1000)
    out.push({
      tokenAddress: row.base_address!,
      symbol: row.base_token?.symbol?.trim() || row.base_address!.slice(0, 8),
      walletAddress: row.maker?.trim() || '',
      tradeUsd,
      tradeAt: new Date(ts * 1000),
      source,
      walletTags: Array.isArray(row.maker_info?.tags) ? row.maker_info!.tags! : [],
    })
  }

  return out
}
