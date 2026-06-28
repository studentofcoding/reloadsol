import { NextResponse } from 'next/server'
import { getStrategyDomainHeartbeats } from '@/strategies/db'
import { getCronServiceUrl } from '@/utils/workers/config'

export const dynamic = 'force-dynamic'

type CronWorkerRow = {
  id: string
  name: string
  domain: string
  schedule: string
  interval_sec: number
  disabled: boolean
  can_trigger: boolean
  trigger_path: string
  status: string
  last_started_at: string
  last_success_at: string
  last_error_at: string
  last_error_msg: string
  next_run_at: string
}

export async function GET() {
  const cronUrl = getCronServiceUrl()
  let cronReachable = false
  let cronUptime: string | null = null
  let workers: CronWorkerRow[] = []

  try {
    const res = await fetch(`${cronUrl}/workers`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const json = (await res.json()) as {
        uptime?: string
        workers?: CronWorkerRow[]
      }
      cronReachable = true
      cronUptime = json.uptime ?? null
      workers = json.workers ?? []
    }
  } catch {
    cronReachable = false
  }

  const dlmmWorker = workers.find((w) => w.id === 'dlmm_manage')
  const domainHeartbeat = await getStrategyDomainHeartbeats({
    dlmmWorkerLastSuccessAt: dlmmWorker?.last_success_at ?? null,
  })

  return NextResponse.json({
    success: true,
    cron_reachable: cronReachable,
    cron_service_url: cronUrl,
    cron_uptime: cronUptime,
    workers,
    domain_heartbeat: domainHeartbeat,
    timestamp: new Date().toISOString(),
  })
}
