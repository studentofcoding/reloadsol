import { NextRequest, NextResponse, connection } from 'next/server'
import { toClimateChipPayload } from '@/utils/climateDisplay'
import { fetchClimate } from '@/utils/climateGate'
import {
  BUYBULK_DATAPUBLIC_SCOUT_ID,
  canPaperNotchFromClimate,
  paperNotchDisabledTip,
  type ScoutChain,
} from '@/utils/data-public-scout'
import {
  insertBuybulkPaperNotch,
  listBuybulkPaperNotches,
} from '@/strategies/buybulk-datapublic-scout-notches'

const NO_STORE = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function isScoutChain(value: unknown): value is ScoutChain {
  return value === 'robinhood' || value === 'solana'
}

/**
 * Durable paper notes for buybulk-datapublic-scout.
 * Climate gate is enforced here (server), not only in the Header chip UI.
 * Never executes live buys/swaps.
 */
export async function GET() {
  await connection()
  try {
    const notches = await listBuybulkPaperNotches()
    return NextResponse.json(
      { ok: true, strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID, notches },
      { headers: NO_STORE },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { ok: false, strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID, error: msg, notches: [] },
      { status: 500, headers: NO_STORE },
    )
  }
}

export async function POST(req: NextRequest) {
  await connection()
  const now = Date.now()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid JSON' },
      { status: 400, headers: NO_STORE },
    )
  }
  const o = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
  if (!o) {
    return NextResponse.json(
      { ok: false, error: 'candidate required' },
      { status: 400, headers: NO_STORE },
    )
  }
  const candidateRaw = o.candidate !== null && typeof o.candidate === 'object' && !Array.isArray(o.candidate)
    ? (o.candidate as Record<string, unknown>)
    : o
  if (!isScoutChain(candidateRaw.chain) || typeof candidateRaw.mint !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'candidate.chain and candidate.mint required' },
      { status: 400, headers: NO_STORE },
    )
  }

  let climateLabel: string = 'Unknown'
  let climateState: string | null = null
  try {
    const gate = await fetchClimate({ failClosed: false, now })
    const chip = toClimateChipPayload(gate, { now })
    climateLabel = chip.label
    climateState = chip.state ?? null
  } catch {
    climateLabel = 'Unknown'
  }

  if (!canPaperNotchFromClimate(climateLabel)) {
    return NextResponse.json(
      {
        ok: false,
        strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
        reason: 'climate_not_safe',
        paperAllowed: false,
        climateLabel,
        error: paperNotchDisabledTip(climateLabel),
      },
      { status: 403, headers: NO_STORE },
    )
  }

  const result = await insertBuybulkPaperNotch({
    candidate: {
      chain: candidateRaw.chain,
      mint: candidateRaw.mint,
      symbol: typeof candidateRaw.symbol === 'string' ? candidateRaw.symbol : candidateRaw.mint.slice(0, 6),
      name: typeof candidateRaw.name === 'string' ? candidateRaw.name : (typeof candidateRaw.symbol === 'string' ? candidateRaw.symbol : candidateRaw.mint.slice(0, 6)),
      kind: typeof candidateRaw.kind === 'string' ? candidateRaw.kind : 'vetted',
      decision: typeof candidateRaw.decision === 'string' ? candidateRaw.decision : null,
      score: typeof candidateRaw.score === 'number' && Number.isFinite(candidateRaw.score)
        ? candidateRaw.score
        : null,
      id: candidateRaw.id != null ? String(candidateRaw.id) : undefined,
      url: typeof candidateRaw.url === 'string' ? candidateRaw.url : null,
      mcap: typeof candidateRaw.mcap === 'number' ? candidateRaw.mcap : null,
      liq: typeof candidateRaw.liq === 'number' ? candidateRaw.liq : null,
      source: typeof candidateRaw.source === 'string' ? candidateRaw.source : null,
    },
    climateLabel,
    climateState,
    climateAtEmitLabel: climateLabel,
    strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
  })

  if (!result.ok) {
    const status = result.reason === 'climate_not_safe' ? 403 : 400
    return NextResponse.json(
      { ok: false, strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID, reason: result.reason },
      { status, headers: NO_STORE },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
      created: result.created,
      notch: result.notch,
    },
    { status: result.created ? 201 : 200, headers: NO_STORE },
  )
}
