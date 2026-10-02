import { NextResponse, connection } from 'next/server'
import { getLastClosedOutcomeAtByStrategy } from '@/strategies/strategy-lifecycle-db'

/**
 * SPEC-config-taxonomy-v1 T5: the `last_success_at` of a strategy row, i.e. its latest closed outcome.
 * The Config tab combines this with each row's own `is_active` (see `strategy-lifecycle.ts`), so this
 * route is a read-only lookup — it neither decides nor stores a lifecycle.
 *
 * Its own route rather than a field on `GET /api/strategies`, which is mid-change in #116.
 */
export async function GET() {
  await connection()
  try {
    return NextResponse.json({ success: true, last_outcome_at: await getLastClosedOutcomeAtByStrategy() })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
