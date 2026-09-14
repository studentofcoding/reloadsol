import { NextResponse, connection } from 'next/server'
import { toClimateChipPayload } from '@/utils/climateDisplay'
import { fetchClimate } from '@/utils/climateGate'

/**
 * Display-only climate chip BFF. Always fetches (even when CLIMATE_GATE is off).
 * Does not apply the gate, does not honor fail-closed as Not safe, and never
 * hard-disables trade controls. Client polls ~30s.
 */
export async function GET() {
  await connection()
  const now = Date.now()
  try {
    const gate = await fetchClimate({ failClosed: false, now })
    return NextResponse.json(toClimateChipPayload(gate, { now }), {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      toClimateChipPayload(
        {
          ok: false,
          error: msg,
          fetchedAt: now,
          computedAt: null,
          state: null,
          h: null,
          cascadeVeto: false,
          sizeKind: 'unknown',
          scale: 1,
        },
        { now },
      ),
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      },
    )
  }
}
