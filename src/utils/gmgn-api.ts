import {
  createPrivateKey,
  randomUUID,
  sign as cryptoSign,
  constants as cryptoConstants,
  type KeyObject,
} from 'crypto'
import { existsSync, readFileSync } from 'fs'
import type { GmgnTrackResponse, GmgnTrackRow } from './gmgn-cli'

const DEFAULT_HOST = 'https://openapi.gmgn.ai'
const DEFAULT_TIMEOUT_MS = 15_000
const PKCS8_PRIVATE_KEY_RE =
  /(-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----)/

export class GmgnApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly resetAt?: number,
  ) {
    super(message)
    this.name = 'GmgnApiError'
  }
}

function getApiKey(): string {
  const key = process.env.GMGN_API_KEY?.trim()
  if (!key) {
    throw new GmgnApiError('GMGN_API_KEY is not set')
  }
  return key
}

function getHost(): string {
  return process.env.GMGN_API_HOST?.trim() || DEFAULT_HOST
}

/**
 * Normalize GMGN signing key to a single PKCS#8 PEM block.
 * Matches gmgn-cli config: one-line `\n` escapes, or keypair.pem with private+public.
 */
export function normalizeGmgnPrivateKeyPem(raw: string): string {
  let value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  if (!value.includes('BEGIN') && existsSync(value)) {
    value = readFileSync(value, 'utf-8')
  }
  value = value.replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
  const match = value.match(PKCS8_PRIVATE_KEY_RE)
  if (!match?.[1]) {
    throw new GmgnApiError(
      'GMGN_PRIVATE_KEY must be a PKCS#8 PEM (-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----). ' +
        'Use the Ed25519/RSA signing key from gmgn-cli config / GMGN API key page — not a Solana wallet secret.',
    )
  }
  return match[1] + '\n'
}

function getPrivateKeyPem(): string {
  const raw = process.env.GMGN_PRIVATE_KEY?.trim()
  if (!raw) {
    throw new GmgnApiError('GMGN_PRIVATE_KEY is not set')
  }
  return normalizeGmgnPrivateKeyPem(raw)
}

function loadGmgnPrivateKey(pem: string): { key: KeyObject; algorithm: 'Ed25519' | 'RSA-SHA256' } {
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GmgnApiError(
      `GMGN_PRIVATE_KEY is not a valid PKCS#8 PEM (Ed25519/RSA): ${detail}`,
    )
  }
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return { key, algorithm: 'Ed25519' }
    case 'rsa':
      return { key, algorithm: 'RSA-SHA256' }
    default:
      throw new GmgnApiError(
        `Unsupported GMGN key type: ${key.asymmetricKeyType}. Supported: Ed25519, RSA`,
      )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseResetAt(headers: Headers, body: unknown): number | undefined {
  const headerReset = headers.get('X-RateLimit-Reset') ?? headers.get('x-ratelimit-reset')
  if (headerReset) {
    const n = Number(headerReset)
    if (Number.isFinite(n)) return n
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const data = record.data
    if (data && typeof data === 'object') {
      const reset = (data as Record<string, unknown>).reset_at
      if (typeof reset === 'number' && Number.isFinite(reset)) return reset
    }
    const reset = record.reset_at
    if (typeof reset === 'number' && Number.isFinite(reset)) return reset
  }
  return undefined
}

function unwrapApiData<T>(body: unknown): T {
  if (!body || typeof body !== 'object') {
    throw new GmgnApiError('Invalid GMGN API response')
  }
  const record = body as Record<string, unknown>
  const code = record.code
  if (code !== 0 && code !== '0') {
    const msg =
      typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : `GMGN API error (code=${String(code)})`
    throw new GmgnApiError(msg, String(code))
  }
  if ('data' in record) {
    return record.data as T
  }
  return body as T
}

/** gmgn-cli signer.js buildMessage — exported for the self-check. */
export function buildGmgnSignMessage(
  subPath: string,
  queryParams: Record<string, string>,
  body: string,
  timestamp: number,
): string {
  const sortedQs = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(queryParams[k]))}`)
    .join('&')
  return `${subPath}:${sortedQs}:${body}:${timestamp}`
}

/** Match gmgn-cli signer.js sign — exported for the self-check. */
export function signGmgnMessage(message: string, privateKeyPem: string): string {
  const pem = normalizeGmgnPrivateKeyPem(privateKeyPem)
  const { key, algorithm } = loadGmgnPrivateKey(pem)
  const msgBuf = Buffer.from(message, 'utf-8')
  try {
    if (algorithm === 'Ed25519') {
      return cryptoSign(null, msgBuf, key).toString('base64')
    }
    return cryptoSign('sha256', msgBuf, {
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString('base64')
  } catch (error) {
    if (error instanceof GmgnApiError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new GmgnApiError(
      `GMGN_PRIVATE_KEY is not a valid PKCS#8 PEM (Ed25519/RSA): ${detail}`,
    )
  }
}

async function gmgnHttp(
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  bodyStr: string | null = null,
  autoRetryOnRateLimit = true,
): Promise<unknown> {
  const host = getHost()
  const params = new URLSearchParams(query)
  const url = `${host}${path}?${params.toString()}`
  const maxAttempts = autoRetryOnRateLimit ? 2 : 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr ?? undefined,
        signal: controller.signal,
      })

      const text = await response.text()
      let body: unknown = null
      if (text.trim()) {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          throw new GmgnApiError(`Invalid JSON from GMGN API: ${text.slice(0, 200)}`)
        }
      }

      if (response.status === 429) {
        const resetAt = parseResetAt(response.headers, body)
        if (attempt < maxAttempts) {
          const waitMs = resetAt
            ? Math.min(Math.max(resetAt * 1000 - Date.now(), 1000), 30_000)
            : 3000
          await sleep(waitMs)
          continue
        }
        throw new GmgnApiError('GMGN rate limit exceeded', 'RATE_LIMIT', resetAt)
      }

      if (!response.ok) {
        const msg =
          body && typeof body === 'object'
            ? String(
                (body as Record<string, unknown>).msg ??
                  (body as Record<string, unknown>).message ??
                  `GMGN HTTP ${response.status}`,
              )
            : `GMGN HTTP ${response.status}`
        throw new GmgnApiError(msg)
      }

      return body
    } catch (error) {
      if (error instanceof GmgnApiError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GmgnApiError('GMGN API request timed out')
      }
      throw new GmgnApiError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  throw new GmgnApiError('GMGN API failed after retries')
}

async function gmgnFetch(
  path: string,
  query: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
  body: unknown = null,
): Promise<unknown> {
  const apiKey = getApiKey()
  const params = {
    ...query,
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: randomUUID(),
  }
  const bodyStr = body != null ? JSON.stringify(body) : null
  return gmgnHttp(
    method,
    path,
    params,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-APIKEY': apiKey,
    },
    bodyStr,
  )
}

/** Signed auth (follow-wallet / trade routes) — mirrors gmgn-cli OpenApiClient.authSignedRequest. */
async function gmgnSignedFetch(
  path: string,
  query: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
  body: unknown = null,
): Promise<unknown> {
  const apiKey = getApiKey()
  const privateKeyPem = getPrivateKeyPem()
  const timestamp = Math.floor(Date.now() / 1000)
  const params = {
    ...query,
    timestamp: String(timestamp),
    client_id: randomUUID(),
  }
  // Signed POST includes JSON body in the message; GET uses empty body string.
  const bodyStr = body != null ? JSON.stringify(body) : ''
  const message = buildGmgnSignMessage(path, params, bodyStr, timestamp)
  const signature = signGmgnMessage(message, privateKeyPem)
  // Never auto-retry POSTs that spend (swap) on 429.
  const autoRetry = method !== 'POST'
  return gmgnHttp(
    method,
    path,
    params,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-APIKEY': apiKey,
      'X-Signature': signature,
    },
    bodyStr || null,
    autoRetry,
  )
}

/** Bound wallets + balances for the API key (`portfolio info`). */
export async function userInfo(): Promise<Record<string, unknown>> {
  const data = unwrapApiData<Record<string, unknown>>(
    await gmgnFetch('/v1/user/info', {}),
  )
  return data ?? {}
}

export async function trackSmartMoney(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    limit: String(params.limit ?? 20),
  }
  if (params.side) query.side = params.side
  const raw = unwrapApiData<GmgnTrackResponse>(await gmgnFetch('/v1/user/smartmoney', query))
  return raw.list ?? []
}

export async function trackKol(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    limit: String(params.limit ?? 20),
  }
  if (params.side) query.side = params.side
  const raw = unwrapApiData<GmgnTrackResponse>(await gmgnFetch('/v1/user/kol', query))
  return raw.list ?? []
}

export async function tokenInfo(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const data = unwrapApiData<Record<string, unknown>>(
    await gmgnFetch('/v1/token/info', {
      chain: params.chain,
      address: params.address,
    }),
  )
  return data ?? {}
}

export async function tokenSecurity(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const data = unwrapApiData<Record<string, unknown>>(
    await gmgnFetch('/v1/token/security', {
      chain: params.chain,
      address: params.address,
    }),
  )
  return data ?? {}
}

export type GmgnMarketRankRow = Record<string, unknown> & {
  address?: string
  symbol?: string
  name?: string
  market_cap?: number
  volume?: number
  liquidity?: number
  holder_count?: number
  launchpad?: string
  launchpad_platform?: string
  website?: string
  twitter_username?: string
  telegram?: string
  price_change_percent?: number
  hot_level?: number
  smart_degen_count?: number
  renowned_count?: number
  visiting_count?: number
}

export type MarketTrendingParams = {
  chain: string
  interval: string
  limit?: number
  minMarketcap?: number
  minVolume?: number
  orderBy?: string
  direction?: 'asc' | 'desc'
}

export async function marketTrending(
  params: MarketTrendingParams,
): Promise<GmgnMarketRankRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    interval: params.interval,
    limit: String(params.limit ?? 100),
  }
  if (params.minMarketcap != null) query.min_marketcap = String(params.minMarketcap)
  if (params.minVolume != null) query.min_volume = String(params.minVolume)
  if (params.orderBy) query.orderby = params.orderBy
  if (params.direction) query.direction = params.direction

  const data = unwrapApiData<{ rank?: GmgnMarketRankRow[] }>(
    await gmgnFetch('/v1/market/rank', query),
  )
  return Array.isArray(data?.rank) ? data.rank : []
}

export type GmgnTokenTraderRow = Record<string, unknown> & {
  address?: string
  profit?: number
  realized_profit?: number
  buy_volume_cur?: number
  amount_percentage?: number
  tags?: string[]
  maker_token_tags?: string[]
}

export type TokenTradersParams = {
  chain: string
  address: string
  limit?: number
  orderBy?: string
  direction?: 'asc' | 'desc'
  tag?: string
}

export async function tokenTraders(
  params: TokenTradersParams,
): Promise<GmgnTokenTraderRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    address: params.address,
    limit: String(params.limit ?? 20),
  }
  if (params.orderBy) query.orderby = params.orderBy
  if (params.direction) query.direction = params.direction
  if (params.tag) query.tag = params.tag
  const data = unwrapApiData<{ list?: GmgnTokenTraderRow[] }>(
    await gmgnFetch('/v1/market/token_top_traders', query),
  )
  return Array.isArray(data?.list) ? data.list : []
}

export type GmgnWalletStats = Record<string, unknown> & {
  wallet_address?: string
  winrate?: number
  pnl?: number
  realized_profit?: number
  buy_count?: number
  sell_count?: number
}

export async function walletStats(params: {
  chain: string
  wallet: string
  period?: '7d' | '30d'
}): Promise<GmgnWalletStats> {
  const data = unwrapApiData<GmgnWalletStats | GmgnWalletStats[]>(
    await gmgnFetch('/v1/user/wallet_stats', {
      chain: params.chain,
      wallet_address: params.wallet,
      period: params.period ?? '30d',
    }),
  )
  if (Array.isArray(data)) return data[0] ?? {}
  return data ?? {}
}

/** Signed-auth route — requires GMGN_PRIVATE_KEY. */
export async function trackFollowWallet(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
  wallet?: string
  minAmountUsd?: number
  maxAmountUsd?: number
}): Promise<GmgnTrackRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    limit: String(params.limit ?? 50),
  }
  if (params.side) query.side = params.side
  if (params.wallet) query.wallet_address = params.wallet
  if (params.minAmountUsd != null) query.min_amount_usd = String(params.minAmountUsd)
  if (params.maxAmountUsd != null) query.max_amount_usd = String(params.maxAmountUsd)
  const raw = unwrapApiData<GmgnTrackResponse>(
    await gmgnSignedFetch('/v1/trade/follow_wallet', query),
  )
  return raw.list ?? []
}

export type GmgnTradeQuote = {
  output_amount?: string
  min_output_amount?: string
  slippage?: number
  [key: string]: unknown
}

export type GmgnTradeSwapResult = {
  order_id?: string
  hash?: string
  status?: string
  [key: string]: unknown
}

export type GmgnTradeOrder = {
  order_id?: string
  status?: string
  hash?: string
  report?: Record<string, unknown>
  [key: string]: unknown
}

/** Exist-auth quote — API key only. */
export async function tradeQuote(params: {
  chain: string
  from: string
  inputToken: string
  outputToken: string
  amount: string
  slippage: number
}): Promise<GmgnTradeQuote> {
  const from =
    params.chain === 'sol' ? params.from : params.from.toLowerCase()
  return unwrapApiData<GmgnTradeQuote>(
    await gmgnFetch('/v1/trade/quote', {
      chain: params.chain,
      from_address: from,
      input_token: params.inputToken,
      output_token: params.outputToken,
      input_amount: params.amount,
      slippage: String(params.slippage),
    }),
  )
}

/** Signed POST swap — spends funds; caller must have confirmed. */
export async function tradeSwap(params: {
  chain: string
  from: string
  inputToken: string
  outputToken: string
  amount: string
  slippage?: number
  autoSlippage?: boolean
  /** Sell % of balance; sets input_amount_bps (percent × 100). */
  percent?: number
}): Promise<GmgnTradeSwapResult> {
  const from =
    params.chain === 'sol' ? params.from : params.from.toLowerCase()
  const body: Record<string, unknown> = {
    chain: params.chain,
    from_address: from,
    input_token: params.inputToken,
    output_token: params.outputToken,
    input_amount:
      params.percent != null ? (params.amount || '0') : params.amount,
  }
  if (params.percent != null) {
    body.input_amount_bps = String(Math.round(params.percent * 100))
  }
  if (params.autoSlippage) {
    body.auto_slippage = true
  } else if (params.slippage != null) {
    body.slippage = params.slippage
  }
  if (params.chain === 'sol') {
    body.is_anti_mev = true
  }
  return unwrapApiData<GmgnTradeSwapResult>(
    await gmgnSignedFetch('/v1/trade/swap', {}, 'POST', body),
  )
}

export async function tradeOrderGet(params: {
  chain: string
  orderId: string
}): Promise<GmgnTradeOrder> {
  return unwrapApiData<GmgnTradeOrder>(
    await gmgnSignedFetch('/v1/trade/query_order', {
      chain: params.chain,
      order_id: params.orderId,
    }),
  )
}

export async function walletHoldings(params: {
  chain: string
  wallet: string
  limit?: number
}): Promise<Record<string, unknown>[]> {
  const wallet =
    params.chain === 'sol' ? params.wallet : params.wallet.toLowerCase()
  const query: Record<string, string> = {
    chain: params.chain,
    wallet_address: wallet,
  }
  if (params.limit != null) query.limit = String(params.limit)
  const data = unwrapApiData<{ holdings?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    await gmgnSignedFetch('/v1/user/wallet_holdings', query),
  )
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Array.isArray(data.holdings)) {
    return data.holdings
  }
  return []
}

/** Normalize a GMGN token/rank row to Jupiter-search-like shape for BulkTokenBuyer. */
export function normalizeGmgnSearchToken(
  row: Record<string, unknown>,
): {
  id: string
  address: string
  name: string
  symbol: string
  icon?: string
  mcap?: number
} | null {
  const address = String(row.address ?? row.token_address ?? '').trim()
  if (!address) return null
  const symbol = String(row.symbol ?? row.token_symbol ?? '???')
  const name = String(row.name ?? row.token_name ?? symbol)
  const icon =
    typeof row.logo === 'string'
      ? row.logo
      : typeof row.logo_url === 'string'
        ? row.logo_url
        : typeof row.icon === 'string'
          ? row.icon
          : undefined
  const mcapRaw = row.market_cap ?? row.mcap ?? row.usd_market_cap
  const mcap =
    typeof mcapRaw === 'number'
      ? mcapRaw
      : typeof mcapRaw === 'string'
        ? Number(mcapRaw)
        : undefined
  return {
    id: address,
    address,
    name,
    symbol,
    icon,
    mcap: Number.isFinite(mcap) ? mcap : undefined,
  }
}

export async function searchTokensForChain(params: {
  chain: string
  query: string
  limit?: number
}): Promise<ReturnType<typeof normalizeGmgnSearchToken>[]> {
  const q = params.query.trim()
  const limit = params.limit ?? 20
  if (!q) {
    const rank = await marketTrending({
      chain: params.chain,
      interval: '1h',
      limit,
      orderBy: 'volume',
      direction: 'desc',
    })
    return rank
      .map((r) => normalizeGmgnSearchToken(r))
      .filter((t): t is NonNullable<typeof t> => t != null)
      .slice(0, limit)
  }

  const looksEvm = /^0x[a-fA-F0-9]{40}$/i.test(q)
  const looksSol = !looksEvm && q.length >= 32 && q.length <= 44
  if (looksEvm || looksSol) {
    try {
      const info = await tokenInfo({ chain: params.chain, address: q })
      const one = normalizeGmgnSearchToken({ ...info, address: q })
      return one ? [one] : []
    } catch {
      return []
    }
  }

  const rank = await marketTrending({
    chain: params.chain,
    interval: '1h',
    limit: 100,
    orderBy: 'volume',
    direction: 'desc',
  })
  const needle = q.toLowerCase()
  return rank
    .map((r) => normalizeGmgnSearchToken(r))
    .filter((t): t is NonNullable<typeof t> => {
      if (!t) return false
      return (
        t.symbol.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle) ||
        t.address.toLowerCase().includes(needle)
      )
    })
    .slice(0, limit)
}
