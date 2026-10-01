import { cacheGet, cacheSet, publishJson } from '@/utils/redis-cache'
import { GmgnApiError, tokenInfo } from '@/utils/gmgn-api'
import { getUsdPrices } from '@/utils/usd-prices'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { RH_CHAIN_ID } from '@/utils/dlmm/rh-clmm/config'
import { getTokenPriceUsd } from '@/utils/dlmm/rh-clmm/dexscreener'
import type { Address } from 'viem'

export const OPEN_PRICES_CHANNEL = 'prices:open'
const OPEN_PRICE_TTL_SEC = 5
const GMGN_CONCURRENCY = 4

export type OpenPriceSource = 'gmgn' | 'jupiter' | 'dexscreener'

export type OpenPriceEvent = {
  mint: string
  price: number
  ts: number
  source: OpenPriceSource
}

type CachedOpenPrice = {
  price: number
  ts: number
  source: OpenPriceSource
}

function openPriceKey(mint: string): string {
  return `prices:open:${mint}`
}

/** Parse USD price from GMGN token info (`price.price` nested object). */
export function parseGmgnTokenPriceUsd(
  info: Record<string, unknown>,
): number | null {
  const priceObj = info.price
  if (priceObj && typeof priceObj === 'object') {
    const raw = (priceObj as Record<string, unknown>).price
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  // rare flat shape
  const flat = info.price_usd ?? info.usd_price
  const n = typeof flat === 'number' ? flat : Number(flat)
  if (Number.isFinite(n) && n > 0) return n
  return null
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

async function writeAndPublish(
  mint: string,
  price: number,
  source: OpenPriceSource,
): Promise<void> {
  const ts = Date.now()
  const entry: CachedOpenPrice = { price, ts, source }
  await cacheSet(openPriceKey(mint), entry, OPEN_PRICE_TTL_SEC)
  await publishJson(OPEN_PRICES_CHANNEL, {
    mint,
    price,
    ts,
    source,
  } satisfies OpenPriceEvent)
}

/**
 * Near-realtime USD prices for open-position mints.
 * Redis TTL 5s → GMGN tokenInfo → fallback (Jupiter on sol, DexScreener on robinhood).
 * Publishes on write.
 */
export async function getOpenPositionPrices(
  mints: string[],
  chain: GmgnTradeChain,
): Promise<Record<string, number>> {
  const unique = Array.from(new Set(mints.filter(Boolean)))
  if (unique.length === 0) return {}

  const out: Record<string, number> = {}
  const missFlags = await Promise.all(
    unique.map(async (mint) => {
      const cached = await cacheGet<CachedOpenPrice>(openPriceKey(mint))
      if (cached && cached.price > 0) {
        out[mint] = cached.price
        return null
      }
      return mint
    }),
  )
  const missing = missFlags.filter((m): m is string => m != null)

  if (missing.length === 0) return out

  let skipGmgn = !process.env.GMGN_API_KEY?.trim()
  const stillMissing: string[] = []

  async function gmgnPass(mints: string[]): Promise<void> {
    if (skipGmgn || mints.length === 0) {
      stillMissing.push(...mints)
      return
    }
    const results = await mapPool(mints, GMGN_CONCURRENCY, async (mint) => {
      try {
        const info = await tokenInfo({ chain, address: mint })
        return { mint, price: parseGmgnTokenPriceUsd(info) }
      } catch (err) {
        if (err instanceof GmgnApiError && err.code === 'RATE_LIMIT') {
          skipGmgn = true
        }
        return { mint, price: null as number | null }
      }
    })
    for (const { mint, price } of results) {
      if (price != null && price > 0) {
        out[mint] = price
        await writeAndPublish(mint, price, 'gmgn')
      } else {
        stillMissing.push(mint)
      }
    }
  }

  if (chain === 'robinhood') {
    // GMGN covers robinhood; DexScreener indexes the RH DEXes and is the fallback.
    await gmgnPass(missing)
    if (stillMissing.length > 0) {
      await mapPool(stillMissing, GMGN_CONCURRENCY, async (mint) => {
        try {
          const price = await getTokenPriceUsd(RH_CHAIN_ID, mint as Address)
          if (price != null && price > 0) {
            out[mint] = price
            await writeAndPublish(mint, price, 'dexscreener')
          }
        } catch (err) {
          console.warn('[open-position-prices] DexScreener fallback failed:', err)
        }
      })
    }
  } else {
    // Batched source FIRST. GMGN takes one request per mint, so the ~161 open positions cost
    // ~40 serial round-trips at GMGN_CONCURRENCY=4 — measured at 52-81s on prod. That outran
    // the 60s pass interval, so the job lock stayed held, every other fire was skipped, and an
    // exit crossing between passes waited 2-4 min for its notification. Jupiter's price v3
    // takes 50 ids per request (4 requests for 161 mints). GMGN is kept as the fallback, so its
    // round count is now whatever the batch could not price rather than the whole set.
    const batched: string[] = []
    if (missing.length > 0) {
      try {
        const { prices: jup } = await getUsdPrices(missing, { fresh: true })
        for (const mint of missing) {
          const price = jup[mint]
          if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
            out[mint] = price
            await writeAndPublish(mint, price, 'jupiter')
          } else {
            batched.push(mint)
          }
        }
      } catch (err) {
        console.warn('[open-position-prices] batched Jupiter failed:', err)
        batched.push(...missing)
      }
    }
    await gmgnPass(batched)
  }

  return out
}
