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

function preferCliTransport(): boolean {
  return process.env.GMGN_TRANSPORT?.trim().toLowerCase() === 'cli'
}

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

async function trackSmartMoneyCli(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const args = [
    'track',
    'smartmoney',
    '--chain',
    params.chain,
    '--limit',
    String(params.limit ?? 20),
    '--raw',
  ]
  if (params.side) args.push('--side', params.side)
  const raw = (await gmgnCliRaw(args)) as GmgnTrackResponse
  return raw.list ?? []
}

async function trackKolCli(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const args = [
    'track',
    'kol',
    '--chain',
    params.chain,
    '--limit',
    String(params.limit ?? 20),
    '--raw',
  ]
  if (params.side) args.push('--side', params.side)
  const raw = (await gmgnCliRaw(args)) as GmgnTrackResponse
  return raw.list ?? []
}

async function tokenInfoCli(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const raw = await gmgnCliRaw([
    'token',
    'info',
    '--chain',
    params.chain,
    '--address',
    params.address,
    '--raw',
  ])
  return raw as Record<string, unknown>
}

async function tokenSecurityCli(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const raw = await gmgnCliRaw([
    'token',
    'security',
    '--chain',
    params.chain,
    '--address',
    params.address,
    '--raw',
  ])
  return raw as Record<string, unknown>
}

export async function trackSmartMoney(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  if (preferCliTransport()) return trackSmartMoneyCli(params)
  return gmgnApi.trackSmartMoney(params)
}

export async function trackKol(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  if (preferCliTransport()) return trackKolCli(params)
  return gmgnApi.trackKol(params)
}

export async function tokenInfo(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  if (preferCliTransport()) return tokenInfoCli(params)
  return gmgnApi.tokenInfo(params)
}

export async function tokenSecurity(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  if (preferCliTransport()) return tokenSecurityCli(params)
  return gmgnApi.tokenSecurity(params)
}

export type { GmgnMarketRankRow, MarketTrendingParams } from './gmgn-api'

async function marketTrendingCli(
  params: gmgnApi.MarketTrendingParams,
): Promise<gmgnApi.GmgnMarketRankRow[]> {
  const args = [
    'market',
    'trending',
    '--chain',
    params.chain,
    '--interval',
    params.interval,
    '--limit',
    String(params.limit ?? 100),
    '--raw',
  ]
  if (params.minMarketcap != null) {
    args.push('--min-marketcap', String(params.minMarketcap))
  }
  if (params.minVolume != null) {
    args.push('--min-volume', String(params.minVolume))
  }
  if (params.orderBy) args.push('--order-by', params.orderBy)
  if (params.direction) args.push('--direction', params.direction)

  const raw = await gmgnCliRaw(args)
  if (!raw || typeof raw !== 'object') return []
  const record = raw as Record<string, unknown>
  const data =
    record.code === 0 || record.code === '0'
      ? (record.data as Record<string, unknown> | undefined)
      : record
  const rank = data?.rank
  return Array.isArray(rank) ? (rank as gmgnApi.GmgnMarketRankRow[]) : []
}

export async function marketTrending(
  params: gmgnApi.MarketTrendingParams,
): Promise<gmgnApi.GmgnMarketRankRow[]> {
  if (preferCliTransport()) return marketTrendingCli(params)
  return gmgnApi.marketTrending(params)
}

export type { GmgnTokenTraderRow, TokenTradersParams, GmgnWalletStats } from './gmgn-api'

async function tokenTradersCli(
  params: gmgnApi.TokenTradersParams,
): Promise<gmgnApi.GmgnTokenTraderRow[]> {
  const args = [
    'token',
    'traders',
    '--chain',
    params.chain,
    '--address',
    params.address,
    '--limit',
    String(params.limit ?? 20),
    '--raw',
  ]
  if (params.orderBy) args.push('--order-by', params.orderBy)
  if (params.direction) args.push('--direction', params.direction)
  if (params.tag) args.push('--tag', params.tag)
  const raw = await gmgnCliRaw(args)
  if (!raw || typeof raw !== 'object') return []
  const record = raw as Record<string, unknown>
  const data =
    record.code === 0 || record.code === '0'
      ? (record.data as Record<string, unknown> | undefined)
      : record
  const list = data?.list ?? (record as { list?: unknown }).list
  return Array.isArray(list) ? (list as gmgnApi.GmgnTokenTraderRow[]) : []
}

export async function tokenTraders(
  params: gmgnApi.TokenTradersParams,
): Promise<gmgnApi.GmgnTokenTraderRow[]> {
  if (preferCliTransport()) return tokenTradersCli(params)
  return gmgnApi.tokenTraders(params)
}

async function walletStatsCli(params: {
  chain: string
  wallet: string
  period?: '7d' | '30d'
}): Promise<gmgnApi.GmgnWalletStats> {
  const raw = await gmgnCliRaw([
    'portfolio',
    'stats',
    '--chain',
    params.chain,
    '--wallet',
    params.wallet,
    '--period',
    params.period ?? '30d',
    '--raw',
  ])
  if (!raw || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>
  const data =
    record.code === 0 || record.code === '0' ? record.data : record
  if (Array.isArray(data)) return (data[0] as gmgnApi.GmgnWalletStats) ?? {}
  return (data as gmgnApi.GmgnWalletStats) ?? {}
}

export async function walletStats(params: {
  chain: string
  wallet: string
  period?: '7d' | '30d'
}): Promise<gmgnApi.GmgnWalletStats> {
  if (preferCliTransport()) return walletStatsCli(params)
  return gmgnApi.walletStats(params)
}

async function trackFollowWalletCli(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
  wallet?: string
  minAmountUsd?: number
  maxAmountUsd?: number
}): Promise<GmgnTrackRow[]> {
  const args = [
    'track',
    'follow-wallet',
    '--chain',
    params.chain,
    '--limit',
    String(params.limit ?? 50),
    '--raw',
  ]
  if (params.side) args.push('--side', params.side)
  if (params.wallet) args.push('--wallet', params.wallet)
  if (params.minAmountUsd != null) {
    args.push('--min-amount-usd', String(params.minAmountUsd))
  }
  if (params.maxAmountUsd != null) {
    args.push('--max-amount-usd', String(params.maxAmountUsd))
  }
  const raw = (await gmgnCliRaw(args)) as GmgnTrackResponse
  return raw.list ?? []
}

/** Always CLI — follow-wallet requires signed auth (GMGN_PRIVATE_KEY). */
export async function trackFollowWallet(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
  wallet?: string
  minAmountUsd?: number
  maxAmountUsd?: number
}): Promise<GmgnTrackRow[]> {
  return trackFollowWalletCli(params)
}

export function isSolMemeTokenAddress(address: string | undefined): boolean {
  if (!address || address === SOL_NATIVE) return false
  if (address.length < 32 || address.length > 44) return false
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
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
