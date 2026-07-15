import { aggregateStrategyReports } from './db'
import {
  DEFAULT_REPORT_TIMEZONE,
  formatHourRangeLabel,
  resolveReportTimeZone,
} from './best-trade-windows'
import { sendStrategyReportDiscord } from '@/utils/discord'
import { sendStrategyReportTelegram } from '@/utils/telegram'
import type { StrategyBestTradeWindows, StrategyReportBreakdown } from './types'

function formatBreakdownLine(b: StrategyReportBreakdown): string {
  const mode = b.is_simulated ? 'SIM' : 'LIVE'
  return `${b.domain}/${b.strategy_id} [${mode}]: ${b.trade_count} trades, WR ${(b.win_rate * 100).toFixed(1)}%, avg PnL ${b.avg_pnl_pct.toFixed(2)}%`
}

function formatBestWindowLine(w: StrategyBestTradeWindows): string | null {
  if (!w.best) return null
  const mode = w.is_simulated ? 'SIM' : 'LIVE'
  const range = formatHourRangeLabel(w.best.start_hour, w.best.end_hour, w.timezone)
  const avg = `${w.best.avg_pnl_pct >= 0 ? '+' : ''}${w.best.avg_pnl_pct.toFixed(0)}%`
  return `${w.strategy_id} [${mode}] ${range} avg ${avg} n=${w.best.trade_count}`
}

export async function sendStrategyReportDigest(params?: {
  from?: string
  to?: string
  timeZone?: string
}): Promise<{ discord: boolean; telegram: boolean; lines: string[] }> {
  const enabledDiscord = process.env.STRATEGY_REPORT_DISCORD_ENABLED === 'true'
  const enabledTelegram = process.env.STRATEGY_REPORT_TELEGRAM_ENABLED === 'true'

  const timeZone = resolveReportTimeZone(
    params?.timeZone ??
      process.env.STRATEGY_REPORT_TZ ??
      DEFAULT_REPORT_TIMEZONE,
  )

  const { breakdown, abPairs, bestTradeWindows, timezone } =
    await aggregateStrategyReports({
      from: params?.from,
      to: params?.to,
      timeZone,
    })

  const lines: string[] = [
    `Strategy report (${params?.from ?? 'all'} → ${params?.to ?? 'now'})`,
    `Total buckets: ${breakdown.length}`,
  ]

  for (const b of breakdown.slice(0, 12)) {
    lines.push(formatBreakdownLine(b))
  }

  const abLines = abPairs
    .filter((p) => p.sim || p.live)
    .slice(0, 5)
    .map((p) => {
      const simWr = p.sim ? `${(p.sim.win_rate * 100).toFixed(1)}%` : '—'
      const liveWr = p.live ? `${(p.live.win_rate * 100).toFixed(1)}%` : '—'
      return `A/B ${p.strategy_id}: sim ${simWr} vs live ${liveWr}`
    })

  lines.push(...abLines)

  const bestLines = bestTradeWindows
    .map(formatBestWindowLine)
    .filter((l): l is string => l != null)
    .slice(0, 8)

  if (bestLines.length > 0) {
    lines.push(`Best (${timezone}):`)
    lines.push(...bestLines)
  }

  const body = lines.join('\n')

  let discord = false
  let telegram = false

  if (enabledDiscord) {
    discord = await sendStrategyReportDiscord(body)
  }
  if (enabledTelegram) {
    telegram = await sendStrategyReportTelegram(body)
  }

  return { discord, telegram, lines }
}
