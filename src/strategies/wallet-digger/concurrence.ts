export type RosterBuyEvent = {
  maker: string
  tokenAddress: string
  tradeAtSec: number
}

export type ConcurrenceCluster = {
  tokenAddress: string
  makers: string[]
  firstTradeAtSec: number
  lastTradeAtSec: number
}

/**
 * Find mints where ≥ minWallets distinct roster makers bought within windowSec.
 * Two-pointer over time-sorted buys per mint.
 */
export function findConcurrenceClusters(params: {
  events: RosterBuyEvent[]
  roster: Set<string>
  windowSec: number
  minWallets: number
}): ConcurrenceCluster[] {
  const { events, roster, windowSec, minWallets } = params
  if (minWallets < 2 || windowSec <= 0) return []

  const byMint = new Map<string, Array<{ maker: string; t: number }>>()
  for (const e of events) {
    if (!e.maker || !e.tokenAddress) continue
    if (!roster.has(e.maker)) continue
    const list = byMint.get(e.tokenAddress) ?? []
    list.push({ maker: e.maker, t: e.tradeAtSec })
    byMint.set(e.tokenAddress, list)
  }

  const out: ConcurrenceCluster[] = []

  Array.from(byMint.entries()).forEach(([tokenAddress, raw]) => {
    const sorted = raw
      .slice()
      .sort((a: { maker: string; t: number }, b: { maker: string; t: number }) => a.t - b.t)
    let best: ConcurrenceCluster | null = null

    let left = 0
    const counts = new Map<string, number>()
    for (let right = 0; right < sorted.length; right++) {
      const r = sorted[right]!
      counts.set(r.maker, (counts.get(r.maker) ?? 0) + 1)

      while (left <= right && r.t - sorted[left]!.t > windowSec) {
        const l = sorted[left]!
        const c = (counts.get(l.maker) ?? 1) - 1
        if (c <= 0) counts.delete(l.maker)
        else counts.set(l.maker, c)
        left++
      }

      if (counts.size >= minWallets) {
        const makers = Array.from(counts.keys()).sort()
        const first = sorted[left]!.t
        const last = r.t
        if (
          !best ||
          makers.length > best.makers.length ||
          (makers.length === best.makers.length &&
            last - first < best.lastTradeAtSec - best.firstTradeAtSec)
        ) {
          best = {
            tokenAddress,
            makers,
            firstTradeAtSec: first,
            lastTradeAtSec: last,
          }
        }
      }
    }

    if (best) out.push(best)
  })

  return out.sort((a, b) => b.makers.length - a.makers.length)
}
