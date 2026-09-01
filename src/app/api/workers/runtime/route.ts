import { NextRequest, NextResponse, connection } from 'next/server'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  listCronWorkerRuntime,
  upsertCronWorkerRuntimeEvent,
  type CronWorkerRuntimeEvent,
} from '@/utils/workers/runtime-db'


function getRuntimeSecret(): string {
  return (
    process.env.TRENDING_TRACKER_SECRET ||
    process.env.SOCIAL_ROLLUP_SECRET ||
    'r3l0ads0l-trending'
  )
}

function extractKey(request: NextRequest): string | null {
  return (
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null
  )
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  await connection()
  if (!isAuthorizedRequest(extractKey(request), getRuntimeSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const workers = await listCronWorkerRuntime()
    return NextResponse.json({ success: true, workers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { success: false, error: message },
      { status: 503 },
    )
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedRequest(extractKey(request), getRuntimeSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    worker_id?: string
    event?: string
    error_msg?: string | null
    at?: string | null
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : ''
  const event = body.event as CronWorkerRuntimeEvent
  if (!workerId || !['begin', 'success', 'fail'].includes(event)) {
    return NextResponse.json(
      {
        success: false,
        error: 'worker_id and event (begin|success|fail) are required',
      },
      { status: 400 },
    )
  }

  try {
    const row = await upsertCronWorkerRuntimeEvent({
      workerId,
      event,
      errorMsg: body.error_msg ?? null,
      at: body.at ?? null,
    })
    return NextResponse.json({ success: true, worker: row })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { success: false, error: message },
      { status: 503 },
    )
  }
}
