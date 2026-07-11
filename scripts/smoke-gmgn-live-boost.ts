#!/usr/bin/env npx tsx
/**
 * Smoke test: GMGN Live Boost After Entry
 *
 * Prerequisites:
 *   - DATABASE_URL or DATABASE_URL_DIRECT (host: use 127.0.0.1 if URL points at Docker DNS)
 *   - At least one OPEN sim position on mcap/signals/gmgn sim wallet
 *
 * Usage:
 *   npx tsx scripts/smoke-gmgn-live-boost.ts
 *   npx tsx scripts/smoke-gmgn-live-boost.ts --mint=YOUR_MINT
 *   npx tsx scripts/smoke-gmgn-live-boost.ts --http   # use HTTP ingest + sim-track instead of direct DB
 *
 * npm run smoke:gmgn-live-boost
 */

import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

function resolveHostDatabaseUrl(): void {
  const direct = process.env.DATABASE_URL_DIRECT?.trim()
  if (direct) {
    process.env.DATABASE_URL = direct
    return
  }
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return
  if (/reloadsol-(bouncer|db)/.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      process.env.DATABASE_URL = parsed.toString()
      console.log('Host run: DATABASE_URL rewritten to 127.0.0.1')
    } catch {
      /* ignore */
    }
  }
}

resolveHostDatabaseUrl()

type CliArgs = {
  mint?: string
  http: boolean
  score: number
  skipIngest: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { http: false, score: 85, skipIngest: false }
  for (const arg of argv) {
    if (arg === '--http') args.http = true
    if (arg === '--skip-ingest') args.skipIngest = true
    if (arg.startsWith('--mint=')) args.mint = arg.slice('--mint='.length).trim()
    if (arg.startsWith('--score=')) {
      const n = Number(arg.slice('--score='.length))
      if (Number.isFinite(n)) args.score = n
    }
  }
  return args
}

const MCAP_SIM_WALLET =
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'
const SIGNALS_SIM_WALLET =
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim'
const GMGN_SIM_WALLET = process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

const WALLETS = [
  { name: 'mcap', address: MCAP_SIM_WALLET },
  { name: 'signals', address: SIGNALS_SIM_WALLET },
  { name: 'gmgn', address: GMGN_SIM_WALLET },
]

type OpenSimTarget = {
  walletName: string
  walletAddress: string
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string
  entryFeatures: Record<string, unknown>
}

function readFeatures(sim: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!sim?.entry_features || typeof sim.entry_features !== 'object') return {}
  return sim.entry_features as Record<string, unknown>
}

async function findOpenSimTargets(mintFilter?: string): Promise<OpenSimTarget[]> {
  const { fetchTradingRecordsForWallet } = await import('@/strategies/db')
  const { computeOpenSimCycle } = await import('@/utils/simulation-trades')
  const { findStrategyBuyRecord } = await import('@/strategies/sim-monitor-snapshots')

  const targets: OpenSimTarget[] = []

  for (const wallet of WALLETS) {
    const records = await fetchTradingRecordsForWallet(wallet.address)
    const mints = new Set<string>()
    for (const rec of records) {
      if (!rec.is_simulation) continue
      for (const t of rec.tokens ?? []) {
        if (t.mintAddress) mints.add(t.mintAddress)
      }
    }

    for (const mint of Array.from(mints)) {
      if (mintFilter && mint !== mintFilter) continue
      const cycle = computeOpenSimCycle(records, mint)
      if (!cycle) continue

      const buyRecord = [...records]
        .reverse()
        .find(
          (r) =>
            r.operationType === 'buy' &&
            r.is_simulation &&
            r.bot_strategy &&
            r.tokens?.some((t) => t.mintAddress === mint),
        )
      if (!buyRecord?.bot_strategy) continue

      const resolvedBuy =
        findStrategyBuyRecord(records, buyRecord.bot_strategy, mint) ?? buyRecord

      const sim = (resolvedBuy.trading_simulation ?? {}) as Record<string, unknown>
      const entryAt =
        typeof sim.entry_at === 'string'
          ? sim.entry_at
          : new Date(resolvedBuy.timestamp).toISOString()

      targets.push({
        walletName: wallet.name,
        walletAddress: wallet.address,
        strategyId: resolvedBuy.bot_strategy ?? 'unknown',
        mintAddress: mint,
        symbol: cycle.symbol ?? mint.slice(0, 8),
        entryAt,
        entryFeatures: readFeatures(sim),
      })
    }
  }

  return targets
}

function printBoostState(label: string, features: Record<string, unknown>): void {
  console.log(`\n--- ${label} ---`)
  console.log('  has_gmgn_hot_after_entry:', features.has_gmgn_hot_after_entry ?? '(unset)')
  console.log('  gmgn_live_boost_score:   ', features.gmgn_live_boost_score ?? '(unset)')
  console.log('  social_boost_score:      ', features.social_boost_score ?? '(unset)')
  console.log('  gmgn_hot_after_entry_at: ', features.gmgn_hot_after_entry_at ?? '(unset)')
  console.log('  minutes_entry_to_gmgn_hot:', features.minutes_entry_to_gmgn_hot ?? '(unset)')
}

async function ingestHotEventHttp(params: {
  mint: string
  symbol: string
  occurredAt: string
  score: number
}): Promise<void> {
  const base =
    process.env.API_BASE_URL?.replace(/\/$/, '') ||
    process.env.SOCIAL_INGEST_BASE_URL?.replace(/\/$/, '') ||
    'http://127.0.0.1:3000'
  const key =
    process.env.SOCIAL_INGEST_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'

  const res = await fetch(`${base}/api/social/ingest?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        {
          token_address: params.mint,
          event_type: 'wallet_buy',
          source: 'gmgn_hot',
          occurred_at: params.occurredAt,
          raw_metadata: {
            gmgn_activity_score: params.score,
            sm_wallet_count_60m: 5,
            kol_wallet_count_60m: 2,
            sm_buy_usd_60m: 1000,
            kol_buy_usd_60m: 500,
            discovery_sources: ['smartmoney', 'kol'],
            symbol: params.symbol,
          },
        },
      ],
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`social ingest failed (${res.status}): ${JSON.stringify(body)}`)
  }
  console.log('HTTP ingest OK:', body)
}

async function ingestHotEventDirect(params: {
  mint: string
  symbol: string
  occurredAt: string
  score: number
}): Promise<void> {
  const { insertSocialEvents } = await import('@/strategies/social/db')
  const result = await insertSocialEvents([
    {
      token_address: params.mint,
      event_type: 'wallet_buy',
      source: 'gmgn_hot',
      occurred_at: params.occurredAt,
      raw_metadata: {
        gmgn_activity_score: params.score,
        sm_wallet_count_60m: 5,
        kol_wallet_count_60m: 2,
        sm_buy_usd_60m: 1000,
        kol_buy_usd_60m: 500,
        discovery_sources: ['smartmoney', 'kol'],
        symbol: params.symbol,
      },
    },
  ])
  console.log('Direct ingest:', result)
}

async function triggerSimTrackHttp(walletName: string): Promise<void> {
  const base = process.env.API_BASE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:3000'
  const key = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
  const paths: Record<string, string> = {
    mcap: '/api/mcap-tracking/sim-track',
    signals: '/api/signals/sim-track',
    gmgn: '/api/gmgn/sim-track',
  }
  const path = paths[walletName]
  if (!path) return
  const res = await fetch(`${base}${path}?key=${encodeURIComponent(key)}`, { method: 'POST' })
  const body = await res.text()
  console.log(`HTTP ${path} (${res.status}):`, body.slice(0, 500))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!process.env.DATABASE_URL?.trim() && !args.http) {
    console.error('Set DATABASE_URL (or use --http for API-only mode)')
    process.exit(1)
  }

  console.log('GMGN Live Boost smoke test')
  console.log('  GMGN_LIVE_BOOST_ENABLED:', process.env.GMGN_LIVE_BOOST_ENABLED ?? '(default true)')
  console.log('  GMGN_LIVE_BOOST_MIN_SCORE:', process.env.GMGN_LIVE_BOOST_MIN_SCORE ?? '50')
  console.log('  hot event score:', args.score)

  const targets = await findOpenSimTargets(args.mint)
  if (targets.length === 0) {
    console.error('\nNo open sim positions found.')
    console.error('Open one first, e.g.:')
    console.error('  curl -X POST "$API_BASE_URL/api/mcap-tracking/sim-track?key=$TRENDING_TRACKER_SECRET"')
    console.error('Or pass --mint=... after you have an open position on that mint.')
    process.exit(1)
  }

  const target = targets[0]
  console.log('\nTarget open position:')
  console.log('  wallet:  ', target.walletName, target.walletAddress)
  console.log('  strategy:', target.strategyId)
  console.log('  mint:    ', target.mintAddress)
  console.log('  entry_at:', target.entryAt)

  printBoostState('Before boost', target.entryFeatures)

  if (target.entryFeatures.has_gmgn_hot_after_entry === 1) {
    console.log('\nAlready boosted — re-run idempotency check via applyGmgnLiveBoost...')
  }

  const hotAt = new Date().toISOString()
  if (!args.skipIngest) {
    console.log('\nIngesting synthetic gmgn_hot at', hotAt)
    if (args.http) {
      await ingestHotEventHttp({
        mint: target.mintAddress,
        symbol: target.symbol,
        occurredAt: hotAt,
        score: args.score,
      })
    } else {
      await ingestHotEventDirect({
        mint: target.mintAddress,
        symbol: target.symbol,
        occurredAt: hotAt,
        score: args.score,
      })
    }
  } else {
    console.log('\nSkipping ingest (--skip-ingest); using existing gmgn_hot in DB')
  }

  const {
    applyGmgnLiveBoost,
    checkGmgnLiveBoostForOpenPosition,
    drainGmgnLiveBoostToasts,
    getGmgnLiveBoostMinScore,
  } = await import('@/strategies/gmgn-live-boost')

  if (args.http) {
    await triggerSimTrackHttp(target.walletName)
  } else {
    const hotEvent = {
      occurred_at: hotAt,
      raw_metadata: {
        gmgn_activity_score: args.score,
        sm_wallet_count_60m: 5,
        kol_wallet_count_60m: 2,
      },
    }

    if (!args.skipIngest) {
      const applied = await applyGmgnLiveBoost({
        tokenAddress: target.mintAddress,
        hotEvent,
        source: 'activity_poll',
      })
      console.log('\napplyGmgnLiveBoost:', applied)
    } else {
      const ok = await checkGmgnLiveBoostForOpenPosition({
        walletAddress: target.walletAddress,
        strategyId: target.strategyId,
        mintAddress: target.mintAddress,
        entryAt: target.entryAt,
        symbol: target.symbol,
      })
      console.log('\ncheckGmgnLiveBoostForOpenPosition:', ok)
    }
  }

  const refreshed = await findOpenSimTargets(target.mintAddress)
  const after = refreshed.find((t) => t.walletAddress === target.walletAddress)
  if (after) {
    printBoostState('After boost', after.entryFeatures)
  }

  const toasts = drainGmgnLiveBoostToasts()
  if (toasts.length > 0) {
    console.log('\nToasts queued:', toasts.length)
    for (const t of toasts) console.log(' ', t.title, '—', t.message)
  }

  const minScore = getGmgnLiveBoostMinScore()
  if (args.score < minScore) {
    console.warn(`\nWARN: --score=${args.score} is below GMGN_LIVE_BOOST_MIN_SCORE=${minScore}; boost may be skipped.`)
  }

  const boosted = after?.entryFeatures.has_gmgn_hot_after_entry === 1
  if (boosted) {
    console.log('\nPASS: live boost applied (has_gmgn_hot_after_entry=1)')
    process.exit(0)
  }

  console.error('\nFAIL: has_gmgn_hot_after_entry not set after smoke run')
  console.error('Check: entry_at < hot occurred_at, score >= min, GMGN_LIVE_BOOST_ENABLED=true')
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
