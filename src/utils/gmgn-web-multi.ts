import { cacheDelByPrefix, cacheGet, cacheSet } from '@/utils/redis-cache'

/**
 * Public gmgn.ai web multi-token client (no API key).
 * OpenAPI (`gmgn-api.ts`) stays the default for trades, search, and rank.
 * Product lock: at most 8 addresses per upstream POST (server 400s at 11).
 */

const DEFAULT_HOST = 'https://gmgn.ai'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_POST_PER_SEC = 0.4
const DEFAULT_POSITIVE_TTL_S = 20
const DEFAULT_NEGATIVE_COOLDOWN_S = 60
const DEFAULT_LEDGER_DEBOUNCE_MS = 350
/** Interim skip marker until `token_info_detect` exists. Not the durable SoT. */
const LEDGER_SEEN_TTL_S = 30 * 24 * 60 * 60
const BACKOFF_BASE_MS = 400
const BACKOFF_CAP_MS = 2_000

/** Never send more than this. Observed server cap is 10; 11 returns HTTP 400. */
export const GMGN_WEB_MULTI_HARD_MAX_BATCH = 8

const FULL_INFO_PATH = '/mrwapi/v1/multi_token_full_info'
const WINDOW_INFO_PATH = '/api/v1/mutil_window_token_info'
const POSITIVE_PREFIX = 'gmgn:web-multi:sol:'
const NEGATIVE_KEY = 'gmgn:web-multi:negative'
const LEDGER_SEEN_PREFIX = 'gmgn:web-ledger-seen:sol:'

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const WEB_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: 'https://gmgn.ai',
  Referer: 'https://gmgn.ai/',
}

export type GmgnWebHolderStatMode = 'never' | 'if-missing' | 'always'

export type FetchGmgnWebMultiOpts = {
  /** Holder-stat GETs are per mint. Default `never`. Snapshot uses `if-missing`. */
  includeHolderStat?: GmgnWebHolderStatMode
  /**
   * Skip mints already marked captured (interim Redis, later `token_info_detect`).
   * Live Freeview must leave this off so the hard ban still sees a live panel.
   */
  ledgerWriteOnce?: boolean
}

export type GmgnWebTokenRow = {
  address: string
  info: Record<string, unknown>
  security: Record<string, unknown>
}

export type GmgnWebMultiErrorCode = 'RATE_LIMIT' | 'BLOCKED' | 'INVALID' | 'UPSTREAM'

export class GmgnWebMultiError extends Error {
  constructor(
    message: string,
    public readonly code: GmgnWebMultiErrorCode,
  ) {
    super(message)
    this.name = 'GmgnWebMultiError'
  }
}

export type GmgnWebMultiMetrics = {
  upstreamCalls: number
  addressesSent: number
  lastBatchSize: number
  http429: number
  http403: number
  cacheHits: number
  coalesced: number
  negativeSkips: number
  ledgerSkips: number
}

type NegativeMark = { untilMs: number; reason: 'RATE_LIMIT' | 'BLOCKED' }

type Slot = {
  promise: Promise<GmgnWebTokenRow | undefined>
  resolve: (row: GmgnWebTokenRow | undefined) => void
  reject: (err: unknown) => void
  settled: boolean
}

type LedgerWaiter = {
  mint: string
  resolve: (row: GmgnWebTokenRow | undefined) => void
  reject: (err: unknown) => void
}

const gate: { chain: Promise<void>; lastAt: number } = {
  chain: Promise.resolve(),
  lastAt: 0,
}

const negativeMem: { untilMs: number; reason?: NegativeMark['reason'] } = {
  untilMs: 0,
}

const inflight = new Map<string, Promise<GmgnWebTokenRow | undefined>>()

const ledgerWaiters: LedgerWaiter[] = []
let ledgerTimer: ReturnType<typeof setTimeout> | null = null
let ledgerFlushing = false

function emptyMetrics(): GmgnWebMultiMetrics {
  return {
    upstreamCalls: 0,
    addressesSent: 0,
    lastBatchSize: 0,
    http429: 0,
    http403: 0,
    cacheHits: 0,
    coalesced: 0,
    negativeSkips: 0,
    ledgerSkips: 0,
  }
}

let metrics = emptyMetrics()

export function getGmgnWebMultiMetrics(): GmgnWebMultiMetrics {
  return { ...metrics }
}

export function gmgnWebMaxBatch(): number {
  const raw = Number(process.env.GMGN_WEB_MULTI_MAX_BATCH ?? GMGN_WEB_MULTI_HARD_MAX_BATCH)
  if (!Number.isFinite(raw)) return GMGN_WEB_MULTI_HARD_MAX_BATCH
  const n = Math.floor(raw)
  if (n < 1) return GMGN_WEB_MULTI_HARD_MAX_BATCH
  return Math.min(GMGN_WEB_MULTI_HARD_MAX_BATCH, n)
}

export function gmgnWebMinIntervalMs(): number {
  const raw = Number(process.env.GMGN_WEB_MAX_POST_PER_SEC ?? DEFAULT_MAX_POST_PER_SEC)
  const rate = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_POST_PER_SEC
  return Math.ceil(1000 / rate)
}

export function gmgnWebPositiveTtlS(): number {
  const raw = Number(process.env.GMGN_WEB_POSITIVE_TTL_S ?? DEFAULT_POSITIVE_TTL_S)
  const s = Number.isFinite(raw) ? raw : DEFAULT_POSITIVE_TTL_S
  return Math.min(30, Math.max(10, Math.floor(s)))
}

export function gmgnWebNegativeCooldownMs(): number {
  const raw = Number(process.env.GMGN_WEB_NEGATIVE_COOLDOWN_S ?? DEFAULT_NEGATIVE_COOLDOWN_S)
  const s = Number.isFinite(raw) ? raw : DEFAULT_NEGATIVE_COOLDOWN_S
  return Math.min(120, Math.max(30, s)) * 1000
}

export function gmgnWebLedgerDebounceMs(): number {
  const raw = Number(process.env.GMGN_WEB_LEDGER_DEBOUNCE_MS ?? DEFAULT_LEDGER_DEBOUNCE_MS)
  const ms = Number.isFinite(raw) ? raw : DEFAULT_LEDGER_DEBOUNCE_MS
  return Math.min(500, Math.max(200, ms))
}

/** `web` only when explicitly set. Anything else, including unset, is OpenAPI. */
export function gmgnTokenInfoSource(): 'web' | 'openapi' {
  return process.env.GMGN_TOKEN_INFO_SOURCE?.trim().toLowerCase() === 'web'
    ? 'web'
    : 'openapi'
}

/** Public web multi is Sol-only. Robinhood stays on OpenAPI. */
export function usesGmgnWebTokenInfo(chain: string): boolean {
  return gmgnTokenInfoSource() === 'web' && chain === 'sol'
}

export function isGmgnWebSolMint(address: string): boolean {
  return SOL_MINT_RE.test(address.trim())
}

export function gmgnWebLedgerSeenKey(address: string): string {
  return `${LEDGER_SEEN_PREFIX}${address}`
}

function positiveKey(address: string): string {
  return `${POSITIVE_PREFIX}${address}`
}

function webHost(): string {
  const raw = process.env.GMGN_WEB_HOST?.trim() || DEFAULT_HOST
  return raw.replace(/\/+$/, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extra delay on top of the min gap. Zero when the gap is already tiny (tests). */
function extraJitterMs(gapMs: number): number {
  if (gapMs <= 5) return 0
  const cap = Math.min(250, Math.round(gapMs * 0.15))
  if (cap <= 0) return 0
  return Math.floor(Math.random() * (cap + 1))
}

function gmgnWebRateGate(): Promise<void> {
  const minIntervalMs = gmgnWebMinIntervalMs()
  const next = gate.chain.then(async () => {
    const wait = Math.max(0, gate.lastAt + minIntervalMs - Date.now())
    const delay = wait + extraJitterMs(minIntervalMs)
    if (delay > 0) await sleep(delay)
    gate.lastAt = Date.now()
  })
  gate.chain = next.catch(() => undefined)
  return next
}

export function normalizeGmgnWebMints(addresses: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of addresses) {
    const address = raw.trim()
    if (!isGmgnWebSolMint(address) || seen.has(address)) continue
    seen.add(address)
    out.push(address)
  }
  return out
}

export function chunkGmgnWebAddresses<T>(items: T[], maxBatch = gmgnWebMaxBatch()): T[][] {
  const size = Math.min(
    GMGN_WEB_MULTI_HARD_MAX_BATCH,
    Math.max(1, Math.floor(maxBatch)),
  )
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function firstNumber(sources: unknown[]): number | null {
  for (const value of sources) {
    const n = readNumber(value)
    if (n != null) return n
  }
  return null
}

function readCount(root: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = readNumber(root[key])
    if (n != null) return n
  }
  return null
}

export function mapGmgnWebTokenRow(
  full: Record<string, unknown>,
  windowRow?: Record<string, unknown> | null,
  holderStat?: Record<string, unknown> | null,
  fallbackAddress?: string,
): GmgnWebTokenRow {
  const stat = isRecord(full.stat) ? { ...full.stat } : {}
  const securityIn = isRecord(full.security) ? { ...full.security } : {}
  const walletIn = isRecord(full.wallet_tags_stat) ? { ...full.wallet_tags_stat } : {}
  const fullDev = isRecord(full.dev) ? full.dev : {}
  const windowDev = windowRow && isRecord(windowRow.dev) ? windowRow.dev : {}
  const dev = { ...fullDev, ...windowDev }

  const top10 = firstNumber([
    securityIn.top_10_holder_rate,
    stat.top_10_holder_rate,
    full.top_10_holder_rate,
    dev.top_10_holder_rate,
  ])
  const creatorRate = firstNumber([
    securityIn.creator_balance_rate,
    stat.creator_hold_rate,
    full.creator_hold_rate,
    stat.dev_team_hold_rate,
    full.dev_team_hold_rate,
  ])
  const sniperRate = firstNumber([
    securityIn.sniper_hold_rate,
    securityIn.top_sniper_hold_rate,
    stat.sniper_hold_rate,
    full.sniper_hold_rate,
    full.top_70_sniper_hold_rate,
  ])
  const insiderRate = firstNumber([
    securityIn.suspected_insider_hold_rate,
    stat.suspected_insider_hold_rate,
    full.suspected_insider_hold_rate,
  ])
  const bundlerRate = firstNumber([
    securityIn.bundler_trader_amount_rate,
    stat.top_bundler_trader_percentage,
    full.bundler_trader_amount_rate,
    full.bundler_rate,
  ])
  const proRate = firstNumber([
    securityIn.pro_trader_hold_rate,
    stat.pro_trader_hold_rate,
    stat.smart_degen_hold_rate,
    stat.bot_degen_rate,
    full.bot_degen_rate,
  ])

  const security: Record<string, unknown> = {
    ...securityIn,
    top_10_holder_rate: top10,
    creator_balance_rate: creatorRate,
    sniper_hold_rate: sniperRate,
    suspected_insider_hold_rate: insiderRate,
    bundler_trader_amount_rate: bundlerRate,
    pro_trader_hold_rate: proRate,
    renounced_mint: securityIn.renounced_mint ?? full.renounced_mint ?? null,
    renounced_freeze_account:
      securityIn.renounced_freeze_account ?? full.renounced_freeze_account ?? null,
    burn_status: securityIn.burn_status ?? full.burn_status ?? null,
    is_honeypot: securityIn.is_honeypot ?? full.is_honeypot ?? null,
    sniper_count:
      securityIn.sniper_count ?? walletIn.sniper_wallets ?? full.sniper_count ?? null,
  }

  const price = windowRow?.price ?? full.price
  const holderCount =
    full.holder_count ?? stat.holder_count ?? windowRow?.holder_count ?? null

  const info: Record<string, unknown> = {
    address: full.address ?? fallbackAddress,
    symbol: full.symbol,
    name: full.name,
    holder_count: holderCount,
    liquidity: full.liquidity,
    price,
    stat,
    dev,
    wallet_tags_stat: walletIn,
  }

  const row: GmgnWebTokenRow = {
    address: String(full.address ?? windowRow?.address ?? fallbackAddress ?? ''),
    info,
    security,
  }
  if (holderStat) applyHolderStat(row, holderStat)
  return row
}

function applyHolderStat(row: GmgnWebTokenRow, stat: Record<string, unknown>): void {
  const sniper = readCount(stat, ['sniper_count', 'sniper_wallets', 'sniper'])
  const insider = readCount(stat, [
    'insider_count',
    'insider_wallets',
    'suspected_insider_count',
    'insider',
  ])
  const bundler = readCount(stat, ['bundler_count', 'bundler_wallets', 'bundler'])
  if (sniper != null) {
    row.security.sniper_count = sniper
    const tags = isRecord(row.info.wallet_tags_stat) ? { ...row.info.wallet_tags_stat } : {}
    tags.sniper_wallets = sniper
    row.info.wallet_tags_stat = tags
  }
  if (insider != null) row.security.insider_count = insider
  if (bundler != null) row.security.bundler_count = bundler
}

function sniperCountMissing(row: GmgnWebTokenRow): boolean {
  return readNumber(row.security.sniper_count) == null
}

function needsHolderStat(row: GmgnWebTokenRow, mode: GmgnWebHolderStatMode): boolean {
  if (mode === 'always') return true
  if (mode === 'if-missing') return sniperCountMissing(row)
  return false
}

function indexRows(
  rows: Record<string, unknown>[],
  mints: string[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const addr =
      typeof row.address === 'string'
        ? row.address
        : typeof row.token_address === 'string'
          ? row.token_address
          : ''
    if (addr) map.set(addr, row)
  }
  if (map.size === 0 && rows.length === mints.length) {
    mints.forEach((mint, i) => map.set(mint, rows[i]!))
  }
  return map
}

function unwrapRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter(isRecord)
  }
  if (!isRecord(body)) {
    throw new GmgnWebMultiError('Invalid GMGN web response', 'UPSTREAM')
  }
  const code = body.code
  if (code !== undefined && code !== 0 && code !== '0') {
    const msg =
      (typeof body.msg === 'string' && body.msg) ||
      (typeof body.message === 'string' && body.message) ||
      (typeof body.reason === 'string' && body.reason) ||
      `GMGN web error (code=${String(code)})`
    throw new GmgnWebMultiError(msg, 'UPSTREAM')
  }
  const data = body.data
  if (Array.isArray(data)) return data.filter(isRecord)
  if (isRecord(data)) {
    if (Array.isArray(data.list)) return data.list.filter(isRecord)
    return [data]
  }
  if (data == null) return []
  throw new GmgnWebMultiError('Invalid GMGN web response', 'UPSTREAM')
}

function isCloudflareChallenge(status: number, text: string): boolean {
  if (status === 403) return true
  return /attention required|cf-error-details|cf-browser-verification|just a moment|cloudflare/i.test(
    text,
  )
}

async function readNegative(): Promise<NegativeMark | null> {
  if (negativeMem.untilMs > Date.now() && negativeMem.reason) {
    return { untilMs: negativeMem.untilMs, reason: negativeMem.reason }
  }
  const cached = await cacheGet<NegativeMark>(NEGATIVE_KEY)
  if (cached && cached.untilMs > Date.now() && (cached.reason === 'RATE_LIMIT' || cached.reason === 'BLOCKED')) {
    negativeMem.untilMs = cached.untilMs
    negativeMem.reason = cached.reason
    return cached
  }
  return null
}

async function markNegative(reason: NegativeMark['reason']): Promise<void> {
  const untilMs = Date.now() + gmgnWebNegativeCooldownMs()
  if (untilMs > negativeMem.untilMs) {
    negativeMem.untilMs = untilMs
    negativeMem.reason = reason
  }
  const ttlS = Math.max(1, Math.ceil(gmgnWebNegativeCooldownMs() / 1000))
  await cacheSet(NEGATIVE_KEY, { untilMs: negativeMem.untilMs, reason }, ttlS)
}

function throwCooling(mark: NegativeMark): never {
  metrics.negativeSkips += 1
  const code = mark.reason === 'BLOCKED' ? 'BLOCKED' : 'RATE_LIMIT'
  throw new GmgnWebMultiError(
    code === 'BLOCKED'
      ? 'GMGN web cooldown after 403/Cloudflare challenge'
      : 'GMGN web cooldown after 429',
    code,
  )
}

async function assertNotCooling(): Promise<void> {
  const mark = await readNegative()
  if (mark) throwCooling(mark)
}

function noteUpstream(path: string, batch: number, status: number): void {
  metrics.upstreamCalls += 1
  metrics.addressesSent += batch
  metrics.lastBatchSize = batch
  const line =
    `[gmgn-web-multi] upstream ${path} batch=${batch} status=${status}` +
    ` calls=${metrics.upstreamCalls} cacheHits=${metrics.cacheHits}` +
    ` http429=${metrics.http429} http403=${metrics.http403}`
  if (status === 429 || status === 403) console.warn(line)
  else console.info(line)
}

async function webFetch(
  method: 'GET' | 'POST',
  path: string,
  batchSize: number,
  body: string | null,
): Promise<unknown> {
  await assertNotCooling()
  const maxAttempts = method === 'GET' ? 1 : 2
  let lastError: GmgnWebMultiError | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await gmgnWebRateGate()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      const response = await fetch(`${webHost()}${path}`, {
        method,
        headers: WEB_HEADERS,
        body: body ?? undefined,
        signal: controller.signal,
      })
      const text = await response.text()
      const challenge =
        response.status === 403 ||
        (response.status === 200 &&
          isCloudflareChallenge(response.status, text) &&
          !text.trim().startsWith('{') &&
          !text.trim().startsWith('[')) ||
        (response.status !== 200 &&
          response.status !== 429 &&
          response.status !== 400 &&
          isCloudflareChallenge(response.status, text))
      if (response.status === 429) metrics.http429 += 1
      if (challenge) metrics.http403 += 1
      noteUpstream(path, batchSize, response.status)

      if (response.status === 429) {
        await markNegative('RATE_LIMIT')
        throw new GmgnWebMultiError('GMGN web rate limit exceeded', 'RATE_LIMIT')
      }
      if (challenge) {
        await markNegative('BLOCKED')
        throw new GmgnWebMultiError('GMGN web blocked by Cloudflare challenge', 'BLOCKED')
      }
      if (response.status === 400) {
        throw new GmgnWebMultiError(
          text.trim().slice(0, 180) || 'GMGN web invalid argument',
          'INVALID',
        )
      }
      if (response.status >= 500 && attempt < maxAttempts) {
        const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
        await sleep(backoff + extraJitterMs(backoff))
        continue
      }
      if (!response.ok) {
        throw new GmgnWebMultiError(`GMGN web HTTP ${response.status}`, 'UPSTREAM')
      }
      if (!text.trim()) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new GmgnWebMultiError('Invalid JSON from GMGN web', 'UPSTREAM')
      }
    } catch (error) {
      if (error instanceof GmgnWebMultiError) {
        if (error.code === 'RATE_LIMIT' || error.code === 'BLOCKED' || error.code === 'INVALID') {
          throw error
        }
        lastError = error
        if (attempt >= maxAttempts) throw error
        const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
        await sleep(backoff + extraJitterMs(backoff))
        continue
      }
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new GmgnWebMultiError('GMGN web request timed out', 'UPSTREAM')
      } else {
        lastError = new GmgnWebMultiError(
          error instanceof Error ? error.message : String(error),
          'UPSTREAM',
        )
      }
      if (attempt >= maxAttempts) throw lastError
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
      await sleep(backoff + extraJitterMs(backoff))
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError ?? new GmgnWebMultiError('GMGN web request failed', 'UPSTREAM')
}

async function postMulti(path: string, addresses: string[]): Promise<Record<string, unknown>[]> {
  const body = JSON.stringify({ chain: 'sol', addresses })
  const parsed = await webFetch('POST', path, addresses.length, body)
  return unwrapRows(parsed)
}

function holderStatPath(mint: string): string {
  return `/vas/api/v1/token_holder_stat/sol/${encodeURIComponent(mint)}`
}

async function fetchHolderStat(mint: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await webFetch('GET', holderStatPath(mint), 1, null)
    const rows = unwrapRows(parsed)
    return rows[0] ?? null
  } catch (error) {
    if (error instanceof GmgnWebMultiError && (error.code === 'RATE_LIMIT' || error.code === 'BLOCKED')) {
      throw error
    }
    return null
  }
}

async function fetchChunk(
  mints: string[],
  mode: GmgnWebHolderStatMode,
): Promise<GmgnWebTokenRow[]> {
  const fullRows = indexRows(await postMulti(FULL_INFO_PATH, mints), mints)
  let windowBy = new Map<string, Record<string, unknown>>()
  try {
    windowBy = indexRows(await postMulti(WINDOW_INFO_PATH, mints), mints)
  } catch (error) {
    if (error instanceof GmgnWebMultiError && (error.code === 'RATE_LIMIT' || error.code === 'BLOCKED')) {
      // Full-info rows are still usable. Cooldown is already set for the next call.
    } else if (!(error instanceof GmgnWebMultiError)) {
      throw error
    }
  }

  const out: GmgnWebTokenRow[] = []
  for (const mint of mints) {
    const full = fullRows.get(mint)
    if (!full) continue
    const row = mapGmgnWebTokenRow(full, windowBy.get(mint), null, mint)
    row.address = mint
    row.info.address = mint
    out.push(row)
  }

  if (mode === 'never') return out

  for (const row of out) {
    if (!needsHolderStat(row, mode)) continue
    try {
      const stat = await fetchHolderStat(row.address)
      if (stat) applyHolderStat(row, stat)
    } catch (error) {
      if (error instanceof GmgnWebMultiError && (error.code === 'RATE_LIMIT' || error.code === 'BLOCKED')) {
        break
      }
    }
  }
  return out
}

function isCachedRow(value: unknown): value is GmgnWebTokenRow {
  if (!isRecord(value)) return false
  return (
    typeof value.address === 'string' &&
    isRecord(value.info) &&
    isRecord(value.security)
  )
}

async function readPositive(address: string): Promise<GmgnWebTokenRow | null> {
  const cached = await cacheGet<unknown>(positiveKey(address))
  return isCachedRow(cached) ? cached : null
}

async function writePositive(row: GmgnWebTokenRow): Promise<void> {
  if (!row.address) return
  await cacheSet(positiveKey(row.address), row, gmgnWebPositiveTtlS())
}

function createSlot(): Slot {
  let resolve: Slot['resolve'] = () => undefined
  let reject: Slot['reject'] = () => undefined
  const slot: Slot = {
    promise: undefined as unknown as Promise<GmgnWebTokenRow | undefined>,
    resolve: (row) => resolve(row),
    reject: (err) => reject(err),
    settled: false,
  }
  slot.promise = new Promise<GmgnWebTokenRow | undefined>((res, rej) => {
    resolve = (row) => {
      if (slot.settled) return
      slot.settled = true
      res(row)
    }
    reject = (err) => {
      if (slot.settled) return
      slot.settled = true
      rej(err)
    }
  })
  return slot
}

function settleResolve(slot: Slot, row: GmgnWebTokenRow | undefined): void {
  slot.resolve(row)
}

function settleReject(slot: Slot, err: unknown): void {
  slot.reject(err)
}

async function fulfillFresh(mints: string[], slots: Slot[], opts: FetchGmgnWebMultiOpts | undefined): Promise<void> {
  const byMint = new Map(mints.map((mint, i) => [mint, slots[i]!]))
  try {
    const cooling = await readNegative()
    if (cooling) {
      const err = new GmgnWebMultiError(
        cooling.reason === 'BLOCKED'
          ? 'GMGN web cooldown after 403/Cloudflare challenge'
          : 'GMGN web cooldown after 429',
        cooling.reason === 'BLOCKED' ? 'BLOCKED' : 'RATE_LIMIT',
      )
      metrics.negativeSkips += mints.length
      for (const slot of slots) settleReject(slot, err)
      return
    }

    const uncached: string[] = []
    for (const mint of mints) {
      const hit = await readPositive(mint)
      if (hit) {
        metrics.cacheHits += 1
        settleResolve(byMint.get(mint)!, hit)
      } else {
        uncached.push(mint)
      }
    }

    const mode = opts?.includeHolderStat ?? 'never'
    for (const chunk of chunkGmgnWebAddresses(uncached)) {
      try {
        const rows = await fetchChunk(chunk, mode)
        const found = new Set<string>()
        for (const row of rows) {
          found.add(row.address)
          await writePositive(row)
          const slot = byMint.get(row.address)
          if (slot) settleResolve(slot, row)
        }
        for (const mint of chunk) {
          if (!found.has(mint)) settleResolve(byMint.get(mint)!, undefined)
        }
      } catch (error) {
        for (const mint of chunk) settleReject(byMint.get(mint)!, error)
      }
    }
  } catch (error) {
    for (const slot of slots) settleReject(slot, error)
  }
}

async function reserveAndFetch(
  mints: string[],
  opts: FetchGmgnWebMultiOpts | undefined,
): Promise<GmgnWebTokenRow[]> {
  if (mints.length === 0) return []

  const joined: Promise<GmgnWebTokenRow | undefined>[] = []
  const fresh: string[] = []
  const slots: Slot[] = []

  for (const mint of mints) {
    const existing = inflight.get(mint)
    if (existing) {
      metrics.coalesced += 1
      joined.push(existing)
      continue
    }
    const slot = createSlot()
    const tracked = slot.promise.finally(() => {
      if (inflight.get(mint) === tracked) inflight.delete(mint)
    })
    inflight.set(mint, tracked)
    fresh.push(mint)
    slots.push(slot)
    joined.push(tracked)
  }

  const run = fulfillFresh(fresh, slots, opts)
  const settled = await Promise.allSettled(joined)
  await run

  const rejected = settled.find((item) => item.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason

  const by = new Map<string, GmgnWebTokenRow>()
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value) by.set(item.value.address, item.value)
  }
  return mints.map((mint) => by.get(mint)).filter((row): row is GmgnWebTokenRow => row != null)
}

/**
 * Fetch Sol token panels from the public web multi endpoints.
 * Dedupes, drops non-mints, and chunks to ≤8. Concurrent callers for the
 * same mint share one upstream batch.
 */
export async function fetchGmgnWebMultiTokenInfo(
  addresses: string[],
  opts?: FetchGmgnWebMultiOpts,
): Promise<GmgnWebTokenRow[]> {
  const mints = normalizeGmgnWebMints(addresses)
  if (mints.length === 0) return []

  let todo = mints
  if (opts?.ledgerWriteOnce) {
    const keep: string[] = []
    for (const mint of mints) {
      if (await hasGmgnWebLedgerCapture(mint)) metrics.ledgerSkips += 1
      else keep.push(mint)
    }
    todo = keep
  }
  return reserveAndFetch(todo, opts)
}

export async function hasGmgnWebLedgerCapture(address: string): Promise<boolean> {
  const hit = await cacheGet<unknown>(gmgnWebLedgerSeenKey(address))
  return hit != null
}

/** Call after a write-once ledger insert wins. Live Freeview does not check this. */
export async function markGmgnWebLedgerCaptured(address: string): Promise<void> {
  const mint = address.trim()
  if (!isGmgnWebSolMint(mint)) return
  await cacheSet(gmgnWebLedgerSeenKey(mint), { capturedAt: Date.now() }, LEDGER_SEEN_TTL_S)
}

function scheduleLedgerFlush(): void {
  if (ledgerTimer != null || ledgerFlushing) return
  ledgerTimer = setTimeout(() => {
    ledgerTimer = null
    void flushLedgerQueue()
  }, gmgnWebLedgerDebounceMs())
}

function takeLedgerBatch(): Array<{ mint: string; waiters: LedgerWaiter[] }> {
  const groups = new Map<string, LedgerWaiter[]>()
  const order: string[] = []
  const remain: LedgerWaiter[] = []
  const max = gmgnWebMaxBatch()
  for (const waiter of ledgerWaiters) {
    const existing = groups.get(waiter.mint)
    if (existing) {
      existing.push(waiter)
      continue
    }
    if (order.length >= max) {
      remain.push(waiter)
      continue
    }
    order.push(waiter.mint)
    groups.set(waiter.mint, [waiter])
  }
  ledgerWaiters.length = 0
  ledgerWaiters.push(...remain)
  return order.map((mint) => ({ mint, waiters: groups.get(mint)! }))
}

async function flushLedgerQueue(): Promise<void> {
  if (ledgerFlushing) return
  ledgerFlushing = true
  try {
    while (ledgerWaiters.length > 0) {
      const groups = takeLedgerBatch()
      if (groups.length === 0) break
      try {
        const rows = await fetchGmgnWebMultiTokenInfo(
          groups.map((group) => group.mint),
          { ledgerWriteOnce: true, includeHolderStat: 'if-missing' },
        )
        const by = new Map(rows.map((row) => [row.address, row]))
        for (const group of groups) {
          const row = by.get(group.mint)
          for (const waiter of group.waiters) waiter.resolve(row)
        }
      } catch (error) {
        for (const group of groups) {
          for (const waiter of group.waiters) waiter.reject(error)
        }
      }
    }
  } finally {
    ledgerFlushing = false
    if (ledgerWaiters.length > 0) scheduleLedgerFlush()
  }
}

/**
 * Queue mints and flush ≤8 on a short debounce. Detect bursts share batches
 * instead of one POST per mint. Resolves `undefined` when the mint was already
 * captured or upstream returned no row.
 */
export function enqueueGmgnWebLedgerMints(
  addresses: string[],
): Promise<Array<GmgnWebTokenRow | undefined>> {
  const mints = normalizeGmgnWebMints(addresses)
  if (mints.length === 0) return Promise.resolve([])
  const promises = mints.map(
    (mint) =>
      new Promise<GmgnWebTokenRow | undefined>((resolve, reject) => {
        ledgerWaiters.push({ mint, resolve, reject })
      }),
  )
  scheduleLedgerFlush()
  return Promise.all(promises)
}

export function enqueueGmgnWebLedgerMint(
  address: string,
): Promise<GmgnWebTokenRow | undefined> {
  return enqueueGmgnWebLedgerMints([address]).then((rows) => rows[0])
}

/** Test-only. Rejects queued ledger waiters so a reset cannot hang a test. */
export function __resetGmgnWebMultiForTests(): void {
  gate.chain = Promise.resolve()
  gate.lastAt = 0
  negativeMem.untilMs = 0
  negativeMem.reason = undefined
  inflight.clear()
  metrics = emptyMetrics()
  if (ledgerTimer) clearTimeout(ledgerTimer)
  ledgerTimer = null
  ledgerFlushing = false
  const pending = ledgerWaiters.splice(0, ledgerWaiters.length)
  for (const waiter of pending) {
    waiter.reject(new GmgnWebMultiError('reset', 'UPSTREAM'))
  }
}

export async function __clearGmgnWebCacheForTests(): Promise<void> {
  await cacheDelByPrefix('gmgn:web-')
}
