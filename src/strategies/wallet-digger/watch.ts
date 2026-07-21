import { evaluateGmgnSecurity } from '@/strategies/gmgn-security-gate'
import { GMGN_SIM_WALLET, openGmgnSimPosition } from '@/strategies/gmgn-open-sim'
import { getMergedGmgnRegistry } from '@/strategies/load-gmgn'
import { sendTelegramOhlcPhotoOrText } from '@/strategies/ohlc-telegram-paint'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import type { GmgnStrategy } from '@/strategies/types'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import {
  isSolMemeTokenAddress,
  tokenInfo,
  tokenSecurity,
  trackFollowWallet,
} from '@/utils/gmgn-cli'
import { log } from '@/utils/unified-logger'
import { findConcurrenceClusters } from './concurrence'
import {
  fetchRecentRosterBuys,
  getFollowedRosterAddresses,
  hasRecentConcurrenceSignal,
  insertConcurrenceSignal,
  insertRosterTradeEvents,
  updateConcurrenceSignalFlags,
} from './db'
import { mergeRosterConfig, type RosterConcurrenceConfig } from './defaults'

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

  const rows = await trackFollowWallet({
    chain: 'sol',
    side: 'buy',
    limit: 100,
  })

  const events = rows
    .filter((r) => r.side !== 'sell' && isSolMemeTokenAddress(r.base_address))
    .map((r) => {
      const ts =
        typeof r.timestamp === 'number' && r.timestamp > 0
          ? r.timestamp
          : Math.floor(Date.now() / 1000)
      return {
        maker: (r.maker ?? '').trim(),
        tokenAddress: r.base_address!,
        side: 'buy' as const,
        amountUsd: typeof r.amount_usd === 'number' ? r.amount_usd : null,
        priceUsd: typeof r.price_usd === 'number' ? r.price_usd : null,
        symbol: r.base_token?.symbol ?? null,
        tradeAt: new Date(ts * 1000),
        txHash: r.transaction_hash ?? null,
      }
    })
    .filter((e) => e.maker && roster.has(e.maker))

  const ingested = await insertRosterTradeEvents(events)

  const recent = await fetchRecentRosterBuys(cfg.windowSec)
  const clusters = findConcurrenceClusters({
    events: recent.map((r) => ({
      maker: r.maker,
      tokenAddress: r.token_address,
      tradeAtSec: Math.floor(new Date(r.trade_at).getTime() / 1000),
    })),
    roster,
    windowSec: cfg.windowSec,
    minWallets: cfg.minWallets,
  })

  const skipped: string[] = []
  let fired = 0

  for (const cluster of clusters) {
    if (await hasRecentConcurrenceSignal(cluster.tokenAddress)) {
      skipped.push(`${cluster.tokenAddress.slice(0, 8)}: recent signal`)
      continue
    }

    let info: Record<string, unknown> = {}
    let security: Record<string, unknown> = {}
    try {
      ;[info, security] = await Promise.all([
        tokenInfo({ chain: 'sol', address: cluster.tokenAddress }),
        tokenSecurity({ chain: 'sol', address: cluster.tokenAddress }),
      ])
    } catch (e) {
      skipped.push(
        `${cluster.tokenAddress.slice(0, 8)}: info/security ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }

    const ageH = tokenAgeHours(info)
    const mcap = marketCapUsd(info)
    const symbol =
      (typeof info.symbol === 'string' && info.symbol) ||
      recent.find((r) => r.token_address === cluster.tokenAddress)?.symbol ||
      cluster.tokenAddress.slice(0, 8)

    if (ageH != null && ageH > cfg.maxTokenAgeHours) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        symbol,
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: mcap,
        skipReason: `age ${ageH.toFixed(1)}h > ${cfg.maxTokenAgeHours}h`,
      })
      skipped.push(`${symbol}: age`)
      continue
    }
    if (mcap != null && (mcap < cfg.minMcapUsd || mcap > cfg.maxMcapUsd)) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        symbol,
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: mcap,
        skipReason: `mcap ${Math.round(mcap)} out of band`,
      })
      skipped.push(`${symbol}: mcap`)
      continue
    }

    const gate = evaluateGmgnSecurity({
      tokenAddress: cluster.tokenAddress,
      chain: 'sol',
      info,
      security,
      config: strategy.config.security,
    })
    if (!gate.pass) {
      await insertConcurrenceSignal({
        tokenAddress: cluster.tokenAddress,
        symbol,
        makers: cluster.makers,
        windowSec: cfg.windowSec,
        firstTradeAt: new Date(cluster.firstTradeAtSec * 1000),
        lastTradeAt: new Date(cluster.lastTradeAtSec * 1000),
        marketCapUsd: mcap,
        skipReason: gate.reasons.join('; '),
      })
      skipped.push(`${symbol}: security`)
      continue
    }

    const signalId = await insertConcurrenceSignal({
      tokenAddress: cluster.tokenAddress,
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
          },
          entryPriceUsd: priceUsd,
        })
        simOpened = true
      } catch (e) {
        log.warn('api_request', 'roster-watch sim open failed', { err: String(e) })
        skipped.push(`${symbol}: sim ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    await updateConcurrenceSignalFlags(signalId, { telegramSent, simOpened })
    if (telegramSent || simOpened) fired++
  }

  log.info('api_request', 'roster-watch tick', {
    ingested,
    clusters: clusters.length,
    fired,
    roster: roster.size,
  })

  return { ingested, clusters: clusters.length, fired, skipped }
}
