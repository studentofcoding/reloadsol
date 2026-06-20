import { aggregateStrategyReports } from './db'
import { sendStrategyReportDiscord } from '@/utils/discord'
import { sendStrategyReportTelegram } from '@/utils/telegram'
import type { StrategyReportBreakdown } from './types'

function formatBreakdownLine(b: StrategyReportBreakdown): string {
  const mode = b.is_simulated ? 'SIM' : 'LIVE'
  return `${b.domain}/${b.strategy_id} [${mode}]: ${b.trade_count} trades, WR ${(b.win_rate * 100).toFixed(1)}%, avg PnL ${b.avg_pnl_pct.toFixed(2)}%`
}

export async function sendStrategyReportDigest(params?: {
  from?: string
  to?: string
}): Promise<{ discord: boolean; telegram: boolean; lines: string[] }> {
  const enabledDiscord = process.env.STRATEGY_REPORT_DISCORD_ENABLED === 'true'
  const enabledTelegram = process.env.STRATEGY_REPORT_TELEGRAM_ENABLED === 'true'

  const { breakdown, abPairs } = await aggregateStrategyReports({
    from: params?.from,
    to: params?.to,
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
