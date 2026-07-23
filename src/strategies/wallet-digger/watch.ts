import { evaluateGmgnSecurity } from '@/strategies/gmgn-security-gate'
import { GMGN_SIM_WALLET, openGmgnSimPosition } from '@/strategies/gmgn-open-sim'
import { getMergedGmgnRegistry } from '@/strategies/load-gmgn'
import { sendTelegramOhlcPhotoOrText } from '@/strategies/ohlc-telegram-paint'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import type { GmgnStrategy } from '@/strategies/types'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import {
  isGmgnTokenAddress,
  tokenInfo,
  tokenSecurity,
  trackFollowWallet,
} from '@/utils/gmgn-cli'
import { log } from '@/utils/unified-logger'
import { findConcurrenceClusters } from './concurrence'
import {
  fetchRecentRosterBuys,
  getFollowedRosterAddresses,
  getRosterHitsMap,
  hasRecentConcurrenceSignal,
  insertConcurrenceSignal,
  insertRosterTradeEvents,
  updateConcurrenceSignalFlags,
} from './db'
import {
  bandConfigForChain,
  mergeRosterConfig,
  passAgeMcapBand,
  type RosterChain,
  type RosterConcurrenceConfig,
} from './defaults'

const STRATEGY_ID = 'gmgn_roster_concurrence'

function readNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function tokenAgeHours(info: Record<string, unknown>): number | null {
  const openTs = readNum(info.open_timestamp) ?? readNum(info.creation_timestamp)
  if (openTs == null || openTs <= 0) return null
  return (Date.now() / 1000 - openTs) / 3600
}

function marketCapUsd(info: Record<string, unknown>): number | null {
  const price = readNum(
    info.price && typeof info.price === 'object'
      ? (info.price as Record<string, unknown>).price
      : info.price,
  )
  const circ = readNum(info.circulating_supply)
  if (price == null || circ == null) return null
  return price * circ
}

async function hasOpenSim(mint: string): Promise<boolean> {
  const records = await fetchTradingRecordsForWallet(GMGN_SIM_WALLET)
  const cycle = computeOpenSimCycle(records, mint)
  return Boolean(cycle)
}

export async function runRosterWatch(params?: {
  rosterConfig?: Partial<RosterConcurrenceConfig>
}): Promise<{
  ingested: number
  clusters: number
  fired: number
  skipped: string[]
}> {
  const registry = await getMergedGmgnRegistry()
  const strategy = registry[STRATEGY_ID]
  if (!strategy?.is_active) {
    return { ingested: 0, clusters: 0, fired: 0, skipped: ['strategy inactive'] }
  }

  const cfg = mergeRosterConfig({
    ...strategy.config.roster,
    ...params?.rosterConfig,
  })

  const roster = await getFollowedRosterAddresses()
  if (roster.size === 0) {
    return { ingested: 0, clusters: 0, fired: 0, skipped: ['no followed roster wallets'] }
  }

  let ingested = 0
  for (const chain of cfg.chains) {
    const rows = await trackFollowWallet({
      chain,
      side: 'buy',
      limit: 100,
    }).catch((e) => {
      log.warn('api_request', 'roster-watch trackFollowWallet failed', {
        chain,
        err: String(e),
      })
      return []
    })

    const events = rows
      .filter((r) => r.side !== 'sell' && isGmgnTokenAddress(chain, r.base_address))
      .map((r) => {
        const ts =
          typeof r.timestamp === 'number' && r.timestamp > 0
            ? r.timestamp
            : Math.floor(Date.now() / 1000)
        return {
          maker: (r.maker ?? '').trim(),
          tokenAddress: r.base_address!,
          chain,
          side: 'buy' as const,
          amountUsd: typeof r.amount_usd === 'number' ? r.amount_usd : null,
          priceUsd: typeof r.price_usd === 'number' ? r.price_usd : null,
          symbol: r.base_token?.symbol ?? null,
          tradeAt: new Date(ts * 1000),
          txHash: r.transaction_hash ?? null,
        }
      })
      .filter((e) => e.maker && roster.has(e.maker))

    ingested += await insertRosterTradeEvents(events)
  }

  const recent = await fetchRecentRosterBuys(cfg.windowSec)
  const byChain = new Map<RosterChain, typeof recent>()
  for (const r of recent) {
    const chain = (r.chain === 'robinhood' ? 'robinhood' : 'sol') as RosterChain
    if (!cfg.chains.includes(chain)) continue
    const list = byChain.get(chain) ?? []
    list.push(r)
    byChain.set(chain, list)
  }

  const skipped: string[] = []
  let fired = 0
  let clusterCount = 0

  const allClusterMakers = new Set<string>()
  const chainClusters: Array<{
    chain: RosterChain
    cluster: ReturnType<typeof findConcurrenceClusters>[number]
  }> = []

  for (const chain of cfg.chains) {
    const chainRecent = byChain.get(chain) ?? []
    const clusters = findConcurrenceClusters({
      events: chainRecent.map((r) => ({
        maker: r.maker,
        tokenAddress: r.token_address,
        tradeAtSec: Math.floor(new Date(r.trade_at).getTime() / 1000),
      })),
      roster,
      windowSec: cfg.windowSec,
      minWallets: cfg.minWallets,
    })
    clusterCount += clusters.length
    for (const cluster of clusters) {
      chainClusters.push({ chain, cluster })
      for (const m of cluster.makers) allClusterMakers.add(m)
    }
  }

  const hitsMap = await getRosterHitsMap(Array.from(allClusterMakers))

  for (const { chain, cluster } of chainClusters) {
    if (await hasRecentConcurrenceSignal(cluster.tokenAddress, 6, chain)) {
      skipped.push(`${chain}:${cluster.tokenAddress.slice(0, 8)}: recent signal`)
      continue
    }

    const hitsSum = cluster.makers.reduce((s, m) => s + (hitsMap.get(m) ?? 0), 0)
    if (hitsSum < cfg.minRunnerHitsSum) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        chain,
        symbol: cluster.tokenAddress.slice(0, 8),
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: null,
        skipReason: `hits_sum ${hitsSum} < ${cfg.minRunnerHitsSum}`,
      })
      skipped.push(`${chain}:${cluster.tokenAddress.slice(0, 8)}: hits_sum`)
      continue
    }

    let info: Record<string, unknown> = {}
    let security: Record<string, unknown> = {}
    try {
      ;[info, security] = await Promise.all([
        tokenInfo({ chain, address: cluster.tokenAddress }),
        tokenSecurity({ chain, address: cluster.tokenAddress }),
      ])
    } catch (e) {
      skipped.push(
        `${chain}:${cluster.tokenAddress.slice(0, 8)}: info/security ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }

    const ageH = tokenAgeHours(info)
    const mcap = marketCapUsd(info)
    const chainRecent = byChain.get(chain) ?? []
    const symbol =
      (typeof info.symbol === 'string' && info.symbol) ||
      chainRecent.find((r) => r.token_address === cluster.tokenAddress)?.symbol ||
      cluster.tokenAddress.slice(0, 8)

    const bandGate = passAgeMcapBand(ageH, mcap, bandConfigForChain(cfg, chain))
    if (!bandGate.ok) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        chain,
        symbol,
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: mcap,
        skipReason: bandGate.reason,
      })
      skipped.push(`${chain}:${symbol}: band`)
      continue
    }

    const gate = evaluateGmgnSecurity({
      tokenAddress: cluster.tokenAddress,
      chain,
      info,
      security,
      config: strategy.config.security,
    })
    if (!gate.pass) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        chain,
        symbol,
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: mcap,
        skipReason: gate.reasons.join('; '),
      })
      skipped.push(`${chain}:${symbol}: security`)
      continue
    }

    const signalId = await insertConcurrenceSignal({
      tokenAddress: cluster.tokenAddress,
      chain,
      symbol,
      makers: cluster.makers,
      windowSec: cfg.windowSec,
      firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
      lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
      marketCapUsd: mcap,
    })

    const shortMakers = cluster.makers.map((m) => `${m.slice(0, 4)}…${m.slice(-4)}`)
    const caption =
      `⚡ <b>Roster concurrence</b> — ${symbol}\n` +
      `Chain: ${chain} · Band: ${bandGate.band} · hitsΣ ${hitsSum}\n` +
      `${cluster.makers.length} followed wallets bought within ${Math.round(cfg.windowSec / 60)}m\n` +
      `Makers: ${shortMakers.join(', ')}\n` +
      (mcap != null ? `Mcap: $${Math.round(mcap).toLocaleString()}\n` : '') +
      `<code>${cluster.tokenAddress}</code>`

    let telegramSent = false
    try {
      const sent = await sendTelegramOhlcPhotoOrText({
        tokenAddress: cluster.tokenAddress,
        symbol,
        caption,
        textBody: caption,
      })
      telegramSent = Boolean(sent?.ok)
    } catch (e) {
      log.warn('api_request', 'roster-watch telegram failed', { err: String(e) })
    }

    let simOpened = false
    if (!(await hasOpenSim(cluster.tokenAddress))) {
      try {
        const priceUsd = readNum(gate.features.gmgn_price_usd) ?? 0.000001
        await openGmgnSimPosition({
          strategy: strategy as GmgnStrategy,
          mintAddress: cluster.tokenAddress,
          symbol,
          entryFeatures: {
            ...gate.features,
            roster_makers: cluster.makers,
            roster_concurrence: true,
            roster_chain: chain,
          },
          entryPriceUsd: priceUsd,
        })
        simOpened = true
      } catch (e) {
        log.warn('api_request', 'roster-watch sim open failed', { err: String(e) })
        skipped.push(`${chain}:${symbol}: sim ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    await updateConcurrenceSignalFlags(signalId, { telegramSent, simOpened })
    if (telegramSent || simOpened) fired++
  }

  log.info('api_request', 'roster-watch tick', {
    ingested,
    clusters: clusterCount,
    fired,
    roster: roster.size,
    chains: cfg.chains,
  })

  return { ingested, clusters: clusterCount, fired, skipped }
}
