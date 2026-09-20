import { NextRequest, NextResponse, connection } from 'next/server'
import { buildEvalReport } from '@/strategies/eval-engine'
import {
  loadEvalDecisionsSince,
  loadEvalRunAccuracy,
  loadEvalRunAccuracySince,
  loadMlPredictionsForRun,
} from '@/strategies/eval-engine-db'
import { CLOSED_LOOP_PRINCIPAL_IDS, isClosedLoopPrincipalId } from '@/strategies/closed-loop-ml'
import { loadOutcomesForMlDataset } from '@/strategies/db'
import {
  getEvalExecMode,
  isEvalEngineEnabled,
  isEvalShadowEnabled,
  isLiveTradeEnabled,
} from '@/strategies/eval-engine'
import { loadEvalLastRun } from '@/strategies/eval-engine.server'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const daysRaw = Number(request.nextUrl.searchParams.get('days') ?? 7)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const runId = request.nextUrl.searchParams.get('run_id')?.trim() || null

    if (runId) {
      const [run, predictions, lastRun] = await Promise.all([
        loadEvalRunAccuracy(runId),
        loadMlPredictionsForRun(runId),
        loadEvalLastRun(),
      ])
      return NextResponse.json(
        {
          success: true,
          enabled: isEvalEngineEnabled(),
          shadow: isEvalShadowEnabled(),
          mode: getEvalExecMode(),
          liveTradeEnabled: isLiveTradeEnabled(),
          lastRun,
          days,
          run,
          predictions,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const [decisions, rows, lastRun, runs] = await Promise.all([
      loadEvalDecisionsSince(since),
      loadOutcomesForMlDataset({ strategyIds: [...CLOSED_LOOP_PRINCIPAL_IDS] }),
      loadEvalLastRun(),
      loadEvalRunAccuracySince(since),
    ])

    const inWindow = rows.filter((row) => {
      const at = row.exit_at ?? row.created_at
      return !!at && at >= since && isClosedLoopPrincipalId(row.strategy_id)
    })
    const evalTagged = inWindow.filter((row) => row.features?.evalEngine === true)
    const baseline = inWindow.filter((row) => row.features?.evalEngine !== true)

    const report = buildEvalReport({
      days,
      decisions,
      evalOutcomes: evalTagged,
      baselineOutcomes: baseline,
    })

    return NextResponse.json(
      {
        success: true,
        enabled: isEvalEngineEnabled(),
        shadow: isEvalShadowEnabled(),
        mode: getEvalExecMode(),
        liveTradeEnabled: isLiveTradeEnabled(),
        lastRun,
        runs,
        ...report,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
