/**
 * RugCheck keyless client + short cache.
 *
 * Free and keyless (verified: 6 rapid calls → all 200). No SDK, plain fetch.
 * Best-effort: any failure → `null` so a tick never breaks. A process-wide
 * min-interval gate mirrors gmgn-api's gate because RugCheck's keyless limits
 * are undocumented.
 */

import { cacheGet, cacheSet } from '@/utils/redis-cache'
import {
  EMPTY_RUGCHECK_FEATURES,
  mapRugcheckReport,
  type RugcheckFeatures,
} from '@/strategies/rugcheck-features'

const DEFAULT_HOST = 'https://api.rugcheck.xyz'
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_TTL_S = 900
const DEFAULT_MIN_INTERVAL_MS = 250

function envFlag(key: string, fallback = false): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === '1' || v === 'true'
}

function envInt(key: string, fallback: number, min = 0): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function isRugcheckEnabled(): boolean {
  return envFlag('RUGCHECK_ENABLED', false)
}

function host(): string {
  return process.env.RUGCHECK_HOST?.trim() || DEFAULT_HOST
}

const gate: { chain: Promise<void>; lastAt: number } = {
  chain: Promise.resolve(),
  lastAt: 0,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Min-interval gate for keyless RugCheck reads (serial, env-tunable). */
function rugcheckGate(): Promise<void> {
  const minIntervalMs = envInt('RUGCHECK_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS, 0)
  const next = gate.chain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, gate.lastAt + minIntervalMs - now)
    if (wait > 0) await sleep(wait)
    gate.lastAt = Date.now()
  })
  gate.chain = next.catch(() => undefined)
  return next
}

async function fetchReport(mint: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    envInt('RUGCHECK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 500),
  )
  try {
    const res = await fetch(
      `${host()}/v1/tokens/${encodeURIComponent(mint)}/report`,
      { headers: { accept: 'application/json' }, signal: controller.signal },
    )
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cacheKey(mint: string): string {
  return `rugcheck:token:sol:${mint.trim().toLowerCase()}`
}

/**
 * Cached RugCheck features for a Solana mint. Returns `null` when disabled or
 * unavailable; the DB stores only when `available` is true.
 */
export async function getRugcheckFeaturesCached(
  mint: string,
): Promise<RugcheckFeatures | null> {
  const address = mint.trim()
  if (!address) return null

  const key = cacheKey(address)
  const cached = await cacheGet<RugcheckFeatures>(key)
  if (cached && typeof cached === 'object' && 'available' in cached) {
    return cached
  }

  await rugcheckGate()
  const raw = await fetchReport(address)
  if (raw == null) return null

  const features = mapRugcheckReport(raw)
  if (!features.available) return { ...EMPTY_RUGCHECK_FEATURES }

  void cacheSet(key, features, envInt('RUGCHECK_TTL_S', DEFAULT_TTL_S, 1))
  return features
}
