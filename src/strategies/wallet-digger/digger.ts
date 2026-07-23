import {
  isEvmTokenAddress,
  isGmgnTokenAddress,
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
  type RosterChain,
  type RosterConcurrenceConfig,
} from './defaults'
import {
  passesSoldAboveBoughtMc,
  readAvgMcEdge,
  readPortfolioBars,
} from './portfolio-edge'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let loggedMissingMcEdge = false

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

function isWalletAddress(chain: RosterChain, address: string): boolean {
  if (chain === 'robinhood') return isEvmTokenAddress(address)
  return address.length >= 32 && address.length <= 44
}

type RunnerMint = { chain: RosterChain; address: string }

async function collectRunnerMintsForChain(
  cfg: RosterConcurrenceConfig,
  chain: RosterChain,
): Promise<RunnerMint[]> {
  const seen = new Set<string>()
  const out: string[] = []

  const push = (addr: string | undefined) => {
    if (!addr || !isGmgnTokenAddress(chain, addr) || seen.has(addr)) return
    seen.add(addr)
    out.push(addr)
  }

  const minVolMcap = chain === 'robinhood' ? 100_000 : 50_000
  const minMoverMcap = chain === 'robinhood' ? 100_000 : 20_000

  const trending = await marketTrending({
    chain,
    interval: '24h',
    limit: 40,
    minMarketcap: minVolMcap,
    orderBy: 'volume',
    direction: 'desc',
  }).catch((e) => {
    log.warn('api_request', 'wallet-digger marketTrending volume failed', {
      chain,
      err: String(e),
    })
    return []
  })
  for (const row of trending) push(typeof row.address === 'string' ? row.address : undefined)

  const movers = await marketTrending({
    chain,
    interval: '6h',
    limit: 40,
    minMarketcap: minMoverMcap,
    orderBy: 'price_change_percent',
    direction: 'desc',
  }).catch((e) => {
    log.warn('api_request', 'wallet-digger marketTrending movers failed', {
      chain,
      err: String(e),
    })
    return []
  })
  for (const row of movers) {
    const chg = readNum(row.price_change_percent)
    if (chg != null && chg < 200) continue
    push(typeof row.address === 'string' ? row.address : undefined)
  }

  const marketSlice = out.slice(0, cfg.digMarketCap)
  const final: RunnerMint[] = marketSlice.map((address) => ({ chain, address }))

  if (chain === 'sol') {
    const won = await fetchWonOutcomeMints({
      sinceHours: cfg.wonOutcomesHours,
      limit: 40,
    }).catch(() => [] as string[])
    const seenFinal = new Set(marketSlice)
    for (const m of won) {
      if (!isGmgnTokenAddress('sol', m) || seenFinal.has(m)) continue
      seenFinal.add(m)
      final.push({ chain: 'sol', address: m })
    }
  }

  return final
}

async function collectRunnerMints(cfg: RosterConcurrenceConfig): Promise<RunnerMint[]> {
  const all: RunnerMint[] = []
  for (const chain of cfg.chains) {
    const part = await collectRunnerMintsForChain(cfg, chain)
    all.push(...part)
  }
  return all
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
  const digRunId = await startDigRun(
    runners.map((r) => ({ chain: r.chain, address: r.address })),
  )
  const errors: string[] = []
  let tradersSeen = 0
  let promoted = 0

  const walletAgg = new Map<
    string,
    { tokens: Set<string>; profit: number; tags: Set<string>; chain: RosterChain }
  >()

  for (const runner of runners) {
    try {
      const list = await tokenTraders({
        chain: runner.chain,
        address: runner.address,
        limit: 100,
        orderBy: 'profit',
        direction: 'desc',
      })
      for (const row of list) {
        const addr = typeof row.address === 'string' ? row.address.trim() : ''
        if (!addr || !isWalletAddress(runner.chain, addr)) continue
        const tags = traderTags(row)
        if (isDenied(tags, cfg.tagDenylist)) continue
        tradersSeen++
        const profit = readNum(row.profit) ?? readNum(row.realized_profit) ?? 0
        const agg = walletAgg.get(addr) ?? {
          tokens: new Set<string>(),
          profit: 0,
          tags: new Set<string>(),
          chain: runner.chain,
        }
        agg.tokens.add(runner.address)
        agg.profit += profit
        for (const t of tags) agg.tags.add(t)
        walletAgg.set(addr, agg)

        await insertDigHit({
          digRunId,
          walletAddress: addr,
          tokenAddress: runner.address,
          chain: runner.chain,
          profitUsd: profit,
          tags,
        })
      }
    } catch (e) {
      errors.push(
        `${runner.chain}:${runner.address.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    await sleep(400)
  }

  for (const [address, agg] of Array.from(walletAgg.entries())) {
    const runnerHits = Math.max(agg.tokens.size, await countWalletRunnerHits(address))
    let portfolio: Record<string, unknown> | null = null
    let passPortfolio = false

    if (runnerHits >= cfg.minRunnerHits) {
      try {
        const stats = await walletStats({
          chain: agg.chain,
          wallet: address,
          period: '30d',
        })
        portfolio = stats
        const bars = readPortfolioBars(stats)
        const mcEdge = passesSoldAboveBoughtMc(stats)
        if (!mcEdge && !loggedMissingMcEdge) {
          loggedMissingMcEdge = true
          const edge = readAvgMcEdge(stats)
          log.info('api_request', 'wallet-digger promote MC-edge unavailable or failed', {
            address: address.slice(0, 8),
            chain: agg.chain,
            boughtAvgMc: edge.boughtAvgMc,
            soldAvgMc: edge.soldAvgMc,
            sampleKeys: Object.keys(stats).slice(0, 24),
          })
        }
        passPortfolio =
          bars.winrate >= cfg.minWinrate &&
          bars.buyCount >= cfg.minBuyCount &&
          bars.pnl >= cfg.minPnl &&
          mcEdge
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
    chains: cfg.chains,
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
