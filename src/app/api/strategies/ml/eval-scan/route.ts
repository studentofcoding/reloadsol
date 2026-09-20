import { NextRequest, NextResponse, connection } from 'next/server'
import { isMlRouteAuthorized } from '@/strategies/ml-api-auth'
import {
  getEvalExecMode,
  isEvalEngineEnabled,
  isLiveTradeEnabled,
} from '@/strategies/eval-engine'
import { loadEvalLastRun, runEvalScan } from '@/strategies/eval-engine.server'

export const maxDuration = 120

export async function GET() {
  await connection()
  const last = await loadEvalLastRun()
  return NextResponse.json(
    {
      success: true,
      enabled: isEvalEngineEnabled(),
      mode: getEvalExecMode(),
      liveTradeEnabled: isLiveTradeEnabled(),
      lastRun: last,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(request: NextRequest) {
  await connection()
  const authError = isMlRouteAuthorized(request)
  if (authError) return authError

  try {
    const dryRun = request.nextUrl.searchParams.get('dry_run') === 'true'
    const result = await runEvalScan({
      paper: dryRun
        ? {
            openPaper: async () => ({ ok: true, opened: false, error: 'dry_run' }),
          }
        : undefined,
    })
    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      ...result.summary,
      decisions: result.decisions.length,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
