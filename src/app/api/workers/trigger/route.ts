import { NextRequest, NextResponse } from 'next/server'
import {
  getCronServiceUrl,
  getCronTriggerSecret,
  isKnownWorkerId,
  WORKER_TRIGGER_PATHS,
} from '@/utils/workers/config'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { workerId?: string }
    const workerId = body.workerId?.trim()

    if (!workerId || !isKnownWorkerId(workerId)) {
      return NextResponse.json(
        { success: false, error: 'Unknown or missing workerId' },
        { status: 400 },
      )
    }

    const triggerPath = WORKER_TRIGGER_PATHS[workerId]
    const cronUrl = getCronServiceUrl()

    const res = await fetch(`${cronUrl}${triggerPath}`, {
      method: 'POST',
      headers: { 'X-Trigger-Secret': getCronTriggerSecret() },
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    })

    const text = await res.text()
    let payload: unknown = { raw: text }
    try {
      payload = JSON.parse(text)
    } catch {
      /* plain text response */
    }

    if (!res.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `Cron trigger failed (${res.status})`,
          workerId,
          cron_response: payload,
        },
        { status: 502 },
      )
    }

    return NextResponse.json({
      success: true,
      workerId,
      trigger_path: triggerPath,
      cron_response: payload,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
