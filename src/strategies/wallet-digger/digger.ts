import {
  isSolMemeTokenAddress,
  marketTrending,
  tokenTraders,
  walletStats,
} from '@/utils/gmgn-cli'
import { log } from '@/utils/unified-logger'
import {
  countWalletRunnerHits,
  demoteExcessRoster,
  fetchWonOutcomeMints,
  finishDigRun,
  insertDigHit,
  startDigRun,
  upsertRosterCandidate,
} from './db'
import {
  mergeRosterConfig,
  type RosterConcurrenceConfig,
} from './defaults'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function readNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function traderTags(row: Record<string, unknown>): string[] {
  const tags: string[] = []
  if (Array.isArray(row.tags)) {
    for (const t of row.tags) if (typeof t === 'string') tags.push(t.toLowerCase())
  }
  if (Array.isArray(row.maker_token_tags)) {
    for (const t of row.maker_token_tags) {
      if (typeof t === 'string') tags.push(t.toLowerCase())
    }
  }
  return tags
}

function isDenied(tags: string[], denylist: string[]): boolean {
  const deny = new Set(denylist.map((t) => t.toLowerCase()))
  return tags.some((t) => deny.has(t))
}

async function collectRunnerMints(cfg: RosterConcurrenceConfig): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []

  const push = (addr: string | undefined) => {
    if (!isSolMemeTokenAddress(addr) || seen.has(addr!)) return
    seen.add(addr!)
    out.push(addr!)
  }

  // Volume leaders
  const trending = await marketTrending({
    chain: 'sol',
    interval: '24h',
    limit: 40,
    minMarketcap: 50_000,
    orderBy: 'volume',
    direction: 'desc',
  }).catch((e) => {
    log.warn('api_request', 'wallet-digger marketTrending volume failed', {
      err: String(e),
    })
    return []
  })
  for (const row of trending) push(typeof row.address === 'string' ? row.address : undefined)

  // Printers: 6h movers
  const movers = await marketTrending({
    chain: 'sol',
    interval: '6h',
    limit: 40,
    minMarketcap: 20_000,
    orderBy: 'price_change_percent',
    direction: 'desc',
  }).catch((e) => {
    log.warn('api_request', 'wallet-digger marketTrending movers failed', {
      err: String(e),
    })
    return []
  })
  for (const row of movers) {
    const chg = readNum(row.price_change_percent)
    if (chg != null && chg < 200) continue // ~3× ≈ +200%
    push(typeof row.address === 'string' ? row.address : undefined)
  }

  const marketSlice = out.slice(0, cfg.digMarketCap)

  const won = await fetchWonOutcomeMints({
    sinceHours: cfg.wonOutcomesHours,
    limit: 40,
  }).catch(() => [] as string[])
  for (const m of won) push(m)

  // Prefer market slice first, then won uniques
  const final: string[] = []
  const finalSeen = new Set<string>()
  for (const m of [...marketSlice, ...won]) {
    if (finalSeen.has(m)) continue
    finalSeen.add(m)
    final.push(m)
  }
  return final
}

export async function runWalletDigger(params?: {
  rosterConfig?: Partial<RosterConcurrenceConfig>
}): Promise<{
  digRunId: number
  runners: number
  tradersSeen: number
  promoted: number
  demoted: number
  errors: string[]
}> {
  const cfg = mergeRosterConfig(params?.rosterConfig)
  const runners = await collectRunnerMints(cfg)
  const digRunId = await startDigRun(runners)
  const errors: string[] = []
  let tradersSeen = 0
  let promoted = 0

  const walletAgg = new Map<
    string,
    { tokens: Set<string>; profit: number; tags: Set<string> }
  >()

  for (const token of runners) {
    try {
      const list = await tokenTraders({
        chain: 'sol',
        address: token,
        limit: 100,
        orderBy: 'profit',
        direction: 'desc',
      })
      for (const row of list) {
        const addr = typeof row.address === 'string' ? row.address.trim() : ''
        if (!addr || addr.length < 32) continue
        const tags = traderTags(row)
        if (isDenied(tags, cfg.tagDenylist)) continue
        tradersSeen++
        const profit = readNum(row.profit) ?? readNum(row.realized_profit) ?? 0
        const agg = walletAgg.get(addr) ?? {
          tokens: new Set<string>(),
          profit: 0,
          tags: new Set<string>(),
        }
        agg.tokens.add(token)
        agg.profit += profit
        for (const t of tags) agg.tags.add(t)
        walletAgg.set(addr, agg)

        await insertDigHit({
          digRunId,
          walletAddress: addr,
          tokenAddress: token,
          profitUsd: profit,
          tags,
        })
      }
    } catch (e) {
      errors.push(`${token.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // weight-5 route — be polite
    await sleep(400)
  }

  for (const [address, agg] of Array.from(walletAgg.entries())) {
    const runnerHits = Math.max(agg.tokens.size, await countWalletRunnerHits(address))
    let portfolio: Record<string, unknown> | null = null
    let passPortfolio = false

    if (runnerHits >= cfg.minRunnerHits) {
      try {
        const stats = await walletStats({
          chain: 'sol',
          wallet: address,
          period: '30d',
        })
        portfolio = stats
        const winrate = readNum(stats.winrate) ?? 0
        const buyCount = readNum(stats.buy_count) ?? 0
        const pnl = readNum(stats.pnl) ?? 0
        passPortfolio =
          winrate >= cfg.minWinrate &&
          buyCount >= cfg.minBuyCount &&
          pnl >= cfg.minPnl
        await sleep(200)
      } catch (e) {
        errors.push(`stats ${address.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const score = runnerHits * 10 + Math.max(agg.profit, 0) / 1000
    const promote = runnerHits >= cfg.minRunnerHits && passPortfolio
    await upsertRosterCandidate({
      address,
      score,
      runnerHits,
      portfolio,
      promote,
    })
    if (promote) promoted++
  }

  const demoted = await demoteExcessRoster(cfg.rosterCap)
  await finishDigRun(digRunId, { tradersSeen, promoted, demoted, errors })

  log.info('api_request', 'wallet-digger dig complete', {
    digRunId,
    runners: runners.length,
    tradersSeen,
    promoted,
    demoted,
    errors: errors.length,
  })

  return {
    digRunId,
    runners: runners.length,
    tradersSeen,
    promoted,
    demoted,
    errors,
  }
}
