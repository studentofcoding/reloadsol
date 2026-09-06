#!/usr/bin/env npx tsx
/**
 * P2: Spawn/kill sim_only search clones from candidate JSON.
 *
 *   npm run mcap:strategy-bandit -- --candidates=tmp/mcap-candidates.json
 *   npm run mcap:strategy-bandit -- --prune
 *   npm run mcap:strategy-bandit -- --promote=search_mcap_foo --target=mcap_enter_first_seen
 */

import { config as loadEnv } from 'dotenv'
import { readFileSync } from 'fs'
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
  if (!url) {
    console.error('Set DATABASE_URL or DATABASE_URL_DIRECT')
    process.exit(1)
  }
  if (/reloadsol-(bouncer|db)/.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      process.env.DATABASE_URL = parsed.toString()
    } catch {
      process.exit(1)
    }
  }
}

resolveHostDatabaseUrl()

type Args = {
  candidates?: string
    prune: boolean
    cycle: boolean
    promote?: string
  target?: string
  domain: 'mcap_tracker' | 'gmgn' | 'signals'
  list: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prune: false,
    cycle: false,
    domain: 'mcap_tracker',
    list: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--candidates=')) args.candidates = arg.slice('--candidates='.length)
    else if (arg === '--prune') args.prune = true
    else if (arg === '--cycle') args.cycle = true
    else if (arg.startsWith('--promote=')) args.promote = arg.slice('--promote='.length)
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length)
    else if (arg.startsWith('--domain=')) {
      args.domain = arg.slice('--domain='.length) as Args['domain']
    } else if (arg === '--list') args.list = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/mcap-strategy-bandit.ts [options]
  --candidates=PATH   Spawn from candidates JSON (max 3 concurrent)
  --prune             Kill search_* that fail fitness
  --cycle             Offline walk-forward → spawn top-K → maybe replace canonical sim
  --list              List active search strategies
  --promote=ID --target=ID   Copy search config onto target live slot
  --domain=mcap_tracker|gmgn|signals
`)
      process.exit(0)
    } else {
      console.error(`Unknown: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

async function main(): Promise<void> {
  const {
    listActiveSearchStrategies,
    spawnFromCandidatesFile,
    pruneLosingSearchStrategies,
    MAX_CONCURRENT_SEARCH,
  } = await import('../src/strategies/strategy-search-bandit')
  const { upsertStrategyDefinition, loadStrategyDefinitionById } = await import(
    '../src/strategies/db'
  )
  const { invalidateMcapTrackerCache } = await import('../src/strategies/load-mcap-tracker')
  const { invalidateGmgnCache } = await import('../src/strategies/load-gmgn')
  const { invalidateSignalsCache } = await import('../src/strategies/load-signals')

  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    const active = await listActiveSearchStrategies(args.domain)
    console.log(`Active search (${args.domain}, max ${MAX_CONCURRENT_SEARCH}):`)
    for (const s of active) console.log(`  ${s.id}  ${s.name}`)
    if (!active.length) console.log('  (none)')
    return
  }

  if (args.cycle) {
    const { runStrategySearchCycle } = await import('../src/strategies/strategy-search-cycle')
    const result = await runStrategySearchCycle(args.domain)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (args.prune) {
    const killed = await pruneLosingSearchStrategies({ domain: args.domain })
    console.log(`Pruned ${killed.length}:`)
    for (const k of killed) console.log(`  ${k.id}: ${k.reason}`)
    return
  }

  if (args.promote && args.target) {
    const source = await loadStrategyDefinitionById(args.promote)
    if (!source) {
      console.error(`Source not found: ${args.promote}`)
      process.exit(1)
    }
    const target = await loadStrategyDefinitionById(args.target)
    const result = await upsertStrategyDefinition({
      id: args.target,
      domain: args.domain,
      name: target?.name ?? args.target,
      description: `Promoted from ${args.promote} at ${new Date().toISOString()}`,
      config: (source.config ?? {}) as Record<string, unknown>,
      is_active: true,
      execution_mode: 'live_only',
    })
    if (!result.ok) {
      console.error(result.error)
      process.exit(1)
    }
    await upsertStrategyDefinition({
      id: args.promote,
      domain: args.domain,
      name: source.name,
      description: source.description,
      config: (source.config ?? {}) as Record<string, unknown>,
      is_active: source.is_active,
      execution_mode: 'sim_only',
    })
    if (args.domain === 'gmgn') invalidateGmgnCache()
    else if (args.domain === 'signals') invalidateSignalsCache()
    else invalidateMcapTrackerCache()
    console.log(`Promoted ${args.promote} → ${args.target} (live_only)`)
    return
  }

  if (!args.candidates) {
    console.error('Pass --candidates=, --prune, --cycle, --list, or --promote=')
    process.exit(1)
  }

  const payload = JSON.parse(readFileSync(resolve(args.candidates), 'utf8')) as {
    candidates?: Array<{
      id: string
      config: Record<string, unknown>
      beatsBaseline?: boolean
    }>
    domain?: string
  }
  const domain = (payload.domain as Args['domain']) || args.domain
  const candidates = (payload.candidates ?? []).map((c) => ({
    id: c.id,
    config: {
      ...(typeof c.config === 'object' && c.config ? c.config : {}),
      // Domain search flattens params onto config
      ...((c.config as { params?: Record<string, unknown> })?.params ?? {}),
    } as {
      entry?: Record<string, unknown>
      exit?: Record<string, unknown>
      entryTemplate?: string
      discovery?: Record<string, unknown>
      security?: Record<string, unknown>
      query?: Record<string, unknown>
      enterScoreFloor?: number
      template?: string
    },
    beatsBaseline: c.beatsBaseline,
  }))
  const spawned = await spawnFromCandidatesFile({
    domain,
    candidates,
    onlyBeatsBaseline: true,
  })
  console.log(`Spawned ${spawned.filter((s) => s.ok).length}/${spawned.length}:`)
  for (const s of spawned) {
    console.log(`  ${s.ok ? 'ok' : 'fail'} ${s.id}${s.error ? ` — ${s.error}` : ''}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
