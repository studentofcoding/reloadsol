import { getSignalsStrategy } from '@/strategies/load-signals'
import {
  findTelegramSignalChannelByChatId,
  insertSignalPriceCrosscheck,
  updateCrosscheckSimOpened,
  type SignalPriceCrosscheckRow,
} from '@/strategies/social/crosscheck-db'
import { buildStrategyId } from '@/strategies/social/crosscheck-slug'
import { parseTelegramAlert } from '@/strategies/social/parse-telegram-alert'
import { upsertStrategyDefinition } from '@/strategies/db'
import { openSignalsSimPosition } from '@/strategies/telegram-alpha-sim'
import { fetchTokenPricesBatch } from '@/utils/jupiter-api'
import { trackTokenMcap } from '@/utils/mcap-tracker'
import { sendTelegramAlert } from '@/utils/telegram'

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

function defaultTolerancePct(): number {
  const raw = process.env.SIGNAL_CROSSCHECK_TOLERANCE_PCT
  const n = raw ? parseFloat(raw) : 3
  return Number.isFinite(n) && n > 0 ? n : 3
}

export function isCrosscheckEnabled(): boolean {
  return parseBoolEnv('SIGNAL_CROSSCHECK_ENABLED', true)
}

export type CrosscheckRequest = {
  raw_message: string
  channel_name?: string
  channel_id?: string | null
  cluster_name?: string
  tolerance_pct?: number
  external_message_id?: string | null
  occurred_at?: string
  skip_sim?: boolean
}

export type CrosscheckResult = {
  ok: boolean
  error?: string
  row?: SignalPriceCrosscheckRow
  parsed?: ReturnType<typeof parseTelegramAlert>
  strategyId?: string
  simOpened?: boolean
}

async function resolveChannelContext(body: CrosscheckRequest): Promise<{
  channel_name: string
  channel_id: string | null
  cluster_name: string
  tolerance_pct: number
  sim_buy_sol: number
  dex_default: string | null
  error?: string
}> {
  if (body.channel_name?.trim()) {
    return {
      channel_name: body.channel_name.trim(),
      channel_id: body.channel_id ?? null,
      cluster_name: body.cluster_name?.trim() || 'cluster',
      tolerance_pct: body.tolerance_pct ?? defaultTolerancePct(),
      sim_buy_sol: 0.01,
      dex_default: null,
    }
  }

  if (body.channel_id) {
    const row = await findTelegramSignalChannelByChatId(String(body.channel_id))
    if (!row) {
      return {
        channel_name: '',
        channel_id: body.channel_id,
        cluster_name: 'cluster',
        tolerance_pct: defaultTolerancePct(),
        sim_buy_sol: 0.01,
        dex_default: null,
        error: `No telegram_signal_channels row for channel_id=${body.channel_id}`,
      }
    }
    return {
      channel_name: row.channel_name,
      channel_id: row.channel_id,
      cluster_name: body.cluster_name?.trim() || row.cluster_name || 'cluster',
      tolerance_pct: body.tolerance_pct ?? Number(row.tolerance_pct) ?? defaultTolerancePct(),
      sim_buy_sol: Number(row.sim_buy_sol) || 0.01,
      dex_default: row.dex_default,
    }
  }

  return {
    channel_name: '',
    channel_id: null,
    cluster_name: 'cluster',
    tolerance_pct: defaultTolerancePct(),
    sim_buy_sol: 0.01,
    dex_default: null,
    error: 'channel_name is required (manual input) or provide a registered channel_id',
  }
}

function pctDiff(signal: number, jupiter: number): number | null {
  if (!Number.isFinite(jupiter) || jupiter <= 0) return null
  return (Math.abs(signal - jupiter) / jupiter) * 100
}

async function notifyCrosscheckResult(params: {
  passed: boolean
  channelName: string
  parsed: NonNullable<ReturnType<typeof parseTelegramAlert>>
  signalPrice: number
  jupiterPrice: number | null
  pct: number | null
  tolerance: number
  strategyId?: string
  simOpened?: boolean
}): Promise<void> {
  if (!params.passed && !parseBoolEnv('SIGNAL_CROSSCHECK_NOTIFY_FAIL', false)) {
    return
  }

  const symbol = params.parsed.token_symbol || params.parsed.token_name || 'token'
  const status = params.passed ? 'PASSED' : 'FAILED'
  const jupiterStr =
    params.jupiterPrice != null ? `$${params.jupiterPrice.toFixed(8)}` : 'n/a'
  const pctStr = params.pct != null ? `${params.pct.toFixed(2)}%` : 'n/a'

  const lines = [
    `<b>Signal cross-check ${status}</b>`,
    `Channel: ${params.channelName}`,
    `Coin: ${params.parsed.token_name ?? symbol} (${params.parsed.token_symbol ?? '?'})`,
    `Mint: <code>${params.parsed.token_address}</code>`,
    `Signal USD: $${params.signalPrice.toFixed(8)}`,
    `Jupiter USD: ${jupiterStr}`,
    `Diff: ${pctStr} (tol ${params.tolerance}%)`,
  ]
  if (params.strategyId) lines.push(`Strategy: <code>${params.strategyId}</code>`)
  if (params.simOpened) lines.push('Sim buy: opened')

  await sendTelegramAlert(lines.join('\n'), { parseMode: 'HTML' })
}

export async function runSignalCrosscheck(body: CrosscheckRequest): Promise<CrosscheckResult> {
  if (!isCrosscheckEnabled()) {
    return { ok: false, error: 'Signal cross-check disabled (SIGNAL_CROSSCHECK_ENABLED=false)' }
  }

  const channelCtx = await resolveChannelContext(body)
  if (channelCtx.error || !channelCtx.channel_name) {
    return { ok: false, error: channelCtx.error ?? 'channel_name required' }
  }

  const parsed = parseTelegramAlert(body.raw_message)
  if (!parsed) {
    return {
      ok: false,
      error: 'Could not parse mint or USD price from message',
    }
  }

  const dex = parsed.dex || channelCtx.dex_default || 'unknown'
  const strategyId = buildStrategyId(dex, channelCtx.cluster_name, channelCtx.channel_name)

  let jupiterPrice: number | null = null
  let diff: number | null = null
  let status: 'passed' | 'failed' | 'error' = 'error'

  try {
    const prices = await fetchTokenPricesBatch([parsed.token_address])
    const priceData = prices[parsed.token_address]
    jupiterPrice = priceData?.price ?? null
    diff = jupiterPrice != null ? pctDiff(parsed.signal_price_usd, jupiterPrice) : null
    if (diff == null) {
      status = 'error'
    } else {
      status = diff <= channelCtx.tolerance_pct ? 'passed' : 'failed'
    }
  } catch {
    status = 'error'
  }

  const row = await insertSignalPriceCrosscheck({
    token_address: parsed.token_address,
    channel_id: channelCtx.channel_id,
    channel_name: channelCtx.channel_name,
    token_name: parsed.token_name,
    token_symbol: parsed.token_symbol,
    dex,
    strategy_id: strategyId,
    signal_price_usd: parsed.signal_price_usd,
    jupiter_price_usd: jupiterPrice,
    pct_diff: diff,
    tolerance_pct: channelCtx.tolerance_pct,
    status,
    market_cap_usd: parsed.market_cap_usd,
    raw_message: body.raw_message,
    external_message_id: body.external_message_id ?? null,
    occurred_at: body.occurred_at,
  })

  if (!row) {
    return { ok: false, error: 'Database table missing — run db/init/05-signal-crosscheck.sql' }
  }

  let simOpened = false

  if (status === 'passed' && !body.skip_sim) {
    const baseStrategy = await getSignalsStrategy('signals_default')
    const baseConfig = baseStrategy?.config ?? {
      template: 'default',
      enterScoreFloor: 50,
      query: { limit: 50, recencyMinutes: 240, minGrowth: 0, holdGrowthFloor: 10 },
      scoring: {},
      execution: { simBuySol: channelCtx.sim_buy_sol, maxOpenPositions: 10 },
    }

    await upsertStrategyDefinition({
      id: strategyId,
      domain: 'signals',
      name: `${channelCtx.channel_name} (${dex})`,
      description: `Telegram alpha cross-check: ${channelCtx.channel_name}`,
      config: {
        ...baseConfig,
        execution: {
          ...baseConfig.execution,
          simBuySol: channelCtx.sim_buy_sol,
        },
        telegram_alpha: {
          channel_name: channelCtx.channel_name,
          cluster_name: channelCtx.cluster_name,
          dex,
        },
      },
      is_active: true,
      execution_mode: 'sim_only',
    })

    const symbol =
      parsed.token_symbol?.trim() ||
      parsed.token_name?.trim() ||
      parsed.token_address.slice(0, 8)

    await openSignalsSimPosition({
      strategyId,
      mintAddress: parsed.token_address,
      symbol,
      solAmount: channelCtx.sim_buy_sol,
      priceUsd: jupiterPrice ?? parsed.signal_price_usd,
      entryFeatures: {
        entry_mcap: parsed.market_cap_usd,
        first_mcap: parsed.market_cap_usd,
        initial_price_usd: jupiterPrice ?? parsed.signal_price_usd,
        signal_price_usd: parsed.signal_price_usd,
        jupiter_price_usd: jupiterPrice,
        pct_diff: diff,
        channel_name: channelCtx.channel_name,
        crosscheck_passed: true,
        token_name: parsed.token_name,
      },
    })

    if (parsed.market_cap_usd != null && parsed.market_cap_usd > 0) {
      await trackTokenMcap(parsed.token_address, symbol, parsed.market_cap_usd)
    }

    await updateCrosscheckSimOpened(row.id)
    simOpened = true
  }

  await notifyCrosscheckResult({
    passed: status === 'passed',
    channelName: channelCtx.channel_name,
    parsed,
    signalPrice: parsed.signal_price_usd,
    jupiterPrice,
    pct: diff,
    tolerance: channelCtx.tolerance_pct,
    strategyId,
    simOpened,
  })

  return {
    ok: true,
    row: { ...row, sim_opened: simOpened },
    parsed,
    strategyId,
    simOpened,
  }
}
