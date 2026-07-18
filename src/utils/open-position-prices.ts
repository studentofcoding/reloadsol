import { cacheGet, cacheSet, publishJson } from '@/utils/redis-cache'
import { GmgnApiError, tokenInfo } from '@/utils/gmgn-api'
import { getTokenPrices } from '@/utils/jupiter-api'

export const OPEN_PRICES_CHANNEL = 'prices:open'
const OPEN_PRICE_TTL_SEC = 5
const GMGN_CONCURRENCY = 4

export type OpenPriceSource = 'gmgn' | 'jupiter'

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
 * Redis TTL 5s → GMGN tokenInfo → Jupiter fallback. Publishes on write.
 */
export async function getOpenPositionPrices(
  mints: string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))]
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

  if (!skipGmgn) {
    const gmgnResults = await mapPool(missing, GMGN_CONCURRENCY, async (mint) => {
      try {
        const info = await tokenInfo({ chain: 'sol', address: mint })
        const price = parseGmgnTokenPriceUsd(info)
        return { mint, price }
      } catch (err) {
        if (err instanceof GmgnApiError && err.code === 'RATE_LIMIT') {
          skipGmgn = true
        }
        return { mint, price: null as number | null }
      }
    })

    for (const { mint, price } of gmgnResults) {
      if (price != null && price > 0) {
        out[mint] = price
        await writeAndPublish(mint, price, 'gmgn')
      } else {
        stillMissing.push(mint)
      }
    }
  } else {
    stillMissing.push(...missing)
  }

  if (stillMissing.length > 0) {
    try {
      const jup = await getTokenPrices(stillMissing)
      for (const mint of stillMissing) {
        const price = jup[mint]
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
          out[mint] = price
          await writeAndPublish(mint, price, 'jupiter')
        }
      }
    } catch (err) {
      console.warn('[open-position-prices] Jupiter fallback failed:', err)
    }
  }

  return out
}
