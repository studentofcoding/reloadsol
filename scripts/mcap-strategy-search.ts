#!/usr/bin/env npx tsx
/**
 * Offline strategy search (P0 mcap + P3 gmgn/signals).
 *
 *   npm run mcap:strategy-search
 *   npm run mcap:strategy-search -- --domain=gmgn --top=5
 *   npm run mcap:strategy-search -- --domain=signals --out=tmp/signals-candidates.json
 *   npm run mcap:strategy-search -- --score-json='{"id":"...","entry":{...},"exit":{...}}'
 */

import { config as loadEnv } from 'dotenv'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

function resolveHostDatabaseUrl(): void {
  const direct = process.env.DATABASE_URL_DIRECT?.trim()
  if (direct) {
    process.env.DATABASE_URL = direct
    return
  }
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.error('Set DATABASE_URL or DATABASE_URL_DIRECT')
    process.exit(1)
  }
  if (/reloadsol-(bouncer|db)/.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      process.env.DATABASE_URL = parsed.toString()
      console.log('Host run: DATABASE_URL → 127.0.0.1')
    } catch {
      console.error('Invalid DATABASE_URL')
      process.exit(1)
    }
  }
}

resolveHostDatabaseUrl()

type CliArgs = {
  holdoutWeeks: number
  minTrades: number
  top: number
  out?: string
  scoreJson?: string
  domain: 'mcap_tracker' | 'gmgn' | 'signals'
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    holdoutWeeks: 4,
    minTrades: 5,
    top: 5,
    domain: 'mcap_tracker',
  }
  for (const arg of argv) {
    if (arg.startsWith('--holdout-weeks=')) {
      args.holdoutWeeks = Number(arg.slice('--holdout-weeks='.length)) || 4
    } else if (arg.startsWith('--min-trades=')) {
      args.minTrades = Number(arg.slice('--min-trades='.length)) || 5
    } else if (arg.startsWith('--top=')) {
      args.top = Number(arg.slice('--top='.length)) || 5
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length)
    } else if (arg.startsWith('--score-json=')) {
      args.scoreJson = arg.slice('--score-json='.length)
    } else if (arg.startsWith('--domain=')) {
      args.domain = arg.slice('--domain='.length) as CliArgs['domain']
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/mcap-strategy-search.ts [options]

Options:
  --domain=DOMAIN     mcap_tracker | gmgn | signals (default mcap_tracker)
  --holdout-weeks=N   Walk-forward holdout (default 4)
  --min-trades=N      Min holdout trades (default 5)
  --top=N             Print top N (default 5)
  --out=PATH          Write candidates JSON
  --score-json=JSON   Score a single McapSearchConfig (Optuna / mcap only)
`)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

async function main(): Promise<void> {
  const { listStrategyOutcomes } = await import('../src/strategies/db')
  const { replayAndScore, walkForwardSearch } = await import(
    '../src/strategies/mcap-exit-replay'
  )
  type McapSearchConfig = import('../src/strategies/mcap-exit-replay').McapSearchConfig
  const { runDomainSearch } = await import('../src/strategies/domain-strategy-search')

  const args = parseArgs(process.argv.slice(2))
  const { rows } = await listStrategyOutcomes({
    domain: args.domain,
    limit: 5000,
    offset: 0,
  })

  console.log(`Loaded ${rows.length} ${args.domain} outcomes`)

  if (args.scoreJson) {
    if (args.domain !== 'mcap_tracker') {
      console.error('--score-json only supported for --domain=mcap_tracker')
      process.exit(1)
    }
    const config = JSON.parse(args.scoreJson) as McapSearchConfig
    const result = walkForwardSearch({
      rows,
      configs: [config],
      holdoutWeeks: args.holdoutWeeks,
      minTradesHoldout: 1,
    })
    const score = result.ranked[0]?.holdout ?? replayAndScore(rows, config)
    console.log(
      JSON.stringify({
        objective: score.totalPnlPct,
        winRate: score.winRate,
        tradeCount: score.tradeCount,
        maxLossStreakWeeks: score.maxLossStreakWeeks,
        configId: score.configId,
        beatsBaseline: result.beatBaseline.some((r) => r.configId === config.id),
      }),
    )
    return
  }

  const result = runDomainSearch({
    domain: args.domain,
    rows,
    holdoutWeeks: args.holdoutWeeks,
    minTradesHoldout: args.minTrades,
  })

  console.log(`Train weeks: ${result.trainWeeks.join(', ') || '(none)'}`)
  console.log(`Holdout weeks: ${result.holdoutWeeks.join(', ') || '(none)'}`)
  if (result.baselineHoldout) {
    console.log(
      `Baseline holdout: net ${result.baselineHoldout.totalPnlPct.toFixed(1)}% · ` +
        `${result.baselineHoldout.tradeCount} trades · ` +
        `WR ${(result.baselineHoldout.winRate * 100).toFixed(1)}%`,
    )
  } else {
    console.log('Baseline holdout: insufficient trades')
  }
  console.log('')

  const top = result.beatBaseline.slice(0, args.top)
  if (top.length === 0) {
    console.log('No configs beat baseline on holdout (or none met min trades).')
    console.log('Top by holdout net anyway:')
    for (const r of result.ranked.slice(0, args.top)) {
      console.log(
        `  ${r.configId}  holdout net ${r.holdout.totalPnlPct.toFixed(1)}%  ` +
          `WR ${(r.holdout.winRate * 100).toFixed(1)}%  n=${r.holdout.tradeCount}`,
      )
    }
  } else {
    console.log(`Top ${top.length} configs beating baseline on holdout:`)
    for (const r of top) {
      console.log(
        `  ${r.configId}\n` +
          `    holdout: net ${r.holdout.totalPnlPct.toFixed(1)}%  WR ${(r.holdout.winRate * 100).toFixed(1)}%  n=${r.holdout.tradeCount}  lossStreak=${r.holdout.maxLossStreakWeeks}\n` +
          `    train:   net ${r.train.totalPnlPct.toFixed(1)}%  WR ${(r.train.winRate * 100).toFixed(1)}%  n=${r.train.tradeCount}`,
      )
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    domain: args.domain,
    holdoutWeeks: result.holdoutWeeks,
    trainWeeks: result.trainWeeks,
    baselineHoldout: result.baselineHoldout,
    candidates: (top.length ? top : result.ranked.slice(0, args.top)).map((r) => ({
      id: r.configId,
      config: r.config,
      holdout: r.holdout,
      train: r.train,
      beatsBaseline: r.beatsBaseline,
    })),
  }

  const defaultOut =
    args.domain === 'mcap_tracker'
      ? 'tmp/mcap-candidates.json'
      : `tmp/${args.domain}-candidates.json`
  const outPath = args.out ?? resolve(__dirname, `../${defaultOut}`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`\nWrote ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
