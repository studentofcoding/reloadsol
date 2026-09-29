import { NextRequest, NextResponse, connection } from 'next/server'
import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { consensusGateMode, getConsensusMinFamilies } from '@/strategies/consensus-gate'

/**
 * Reader for the (shadow) strategy-consensus gate sink.
 *
 * `would_gate` rows answer "if the gate were enforced, we would have skipped this open";
 * they are only meaningful once `evidence_significant` is true, which today it is not.
 */
export async function GET(request: NextRequest) {
  await connection()
  try {
    const raw = Number(new URL(request.url).searchParams.get('limit'))
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 50

    const { rows } = await query<{
      created_at: string
      chain: string
      strategy_id: string
      token_address: string
      symbol: string | null
      family_count: number
      families: string[]
      min_families: number
      decision: string
      reason: string
      evidence_significant: boolean
      mode: string
    }>(
      `SELECT created_at, chain, strategy_id, token_address, symbol,
              family_count, families, min_families, decision, reason,
              evidence_significant, mode
         FROM strategy_consensus_shadow
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    )

    const { rows: counts } = await query<{ decision: string; n: number }>(
      `SELECT decision, count(*)::int AS n
         FROM strategy_consensus_shadow
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY 1`,
    )

    return NextResponse.json({
      success: true,
      mode: consensusGateMode(),
      min_families: getConsensusMinFamilies(),
      counts_7d: Object.fromEntries(counts.map((c) => [c.decision, Number(c.n)])),
      rows: rows.map((r) => ({
        created_at: r.created_at,
        chain: r.chain,
        strategy_id: r.strategy_id,
        token_address: r.token_address,
        symbol: r.symbol,
        family_count: Number(r.family_count),
        families: r.families ?? [],
        min_families: Number(r.min_families),
        decision: r.decision,
        reason: r.reason,
        evidence_significant: r.evidence_significant,
        mode: r.mode,
      })),
    })
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return NextResponse.json({
        success: true,
        mode: consensusGateMode(),
        min_families: getConsensusMinFamilies(),
        counts_7d: {},
        rows: [],
      })
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
