import { NextRequest, NextResponse } from 'next/server'
import {
  getDefaultPotentialExitOverlayConfig,
  loadPotentialExitOverlayConfig,
  parsePotentialExitOverlayConfig,
  previewOverlayForBase,
  savePotentialExitOverlayConfig,
  type PotentialExitOverlayConfig,
} from '@/strategies/potential-exit-overlay-config'
import {
  getMlPotentialExitMode,
  getMlPotentialExitModeFromEnv,
} from '@/strategies/potential-exit-overlay'
import { existsSync, readFileSync } from 'fs'
import path from 'path'


const PREVIEW_BASE = {
  stopLossPct: -50,
  takeProfitPct: 200,
  maxHoldHours: 96,
}

function readPotentialReady(): boolean | null {
  try {
    const dir =
      process.env.ML_POTENTIAL_ARTIFACT_DIR ||
      path.join(process.cwd(), 'ml', 'artifacts', 'v2-potential')
    const metaPath = path.join(dir, 'model.meta.json')
    if (!existsSync(metaPath)) return null
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      metrics?: { potential_ready?: boolean; gate_ready?: boolean }
      stage?: string
    }
    const m = meta.metrics
    if (m?.potential_ready === true) return true
    if (meta.stage === 'potential' && m?.gate_ready === true) return true
    return false
  } catch {
    return null
  }
}

function getPotentialMinRows(): number {
  const raw = process.env.ML_POTENTIAL_MIN_ROWS
  if (raw == null || raw === '') return 30
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30
}

export async function GET() {
  try {
    const config = await loadPotentialExitOverlayConfig()
    const effectiveMode = getMlPotentialExitMode(config.exitModeOverride)
    const preview: Record<string, unknown> = {}
    for (const tier of [1, 2, 3, 4] as const) {
      preview[`tier_${tier}`] = previewOverlayForBase(config, PREVIEW_BASE, tier)
    }

    return NextResponse.json({
      success: true,
      config,
      defaults: getDefaultPotentialExitOverlayConfig(),
      effectiveMode,
      envMode: getMlPotentialExitModeFromEnv(),
      previewBase: PREVIEW_BASE,
      preview,
      potentialReady: readPotentialReady(),
      potentialMinRows: getPotentialMinRows(),
      potentialMinRowsRecommended: 30,
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

type PatchBody = {
  config?: Record<string, unknown>
  reset?: boolean
  confirm_apply?: boolean
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as PatchBody

    let next: PotentialExitOverlayConfig
    if (body.reset) {
      next = getDefaultPotentialExitOverlayConfig()
    } else if (body.config) {
      next = parsePotentialExitOverlayConfig(body.config)
    } else {
      return NextResponse.json(
        { success: false, error: 'Provide config or reset: true' },
        { status: 400 },
      )
    }

    if (next.exitModeOverride === 'apply' && body.confirm_apply !== true) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Enabling apply requires confirm_apply: true (sim only; live exits unchanged)',
        },
        { status: 400 },
      )
    }

    const result = await savePotentialExitOverlayConfig(next)
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error ?? 'save failed' },
        { status: 500 },
      )
    }

    const config = await loadPotentialExitOverlayConfig()
    return NextResponse.json({
      success: true,
      config,
      effectiveMode: getMlPotentialExitMode(config.exitModeOverride),
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
