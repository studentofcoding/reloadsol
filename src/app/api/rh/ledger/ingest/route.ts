import { NextRequest, NextResponse, connection } from 'next/server'
import {
  expandRhLedgerEvent,
  insertRhLedgerRows,
  syncTrackedRhWallets,
  type RhLedgerEvent,
} from '@/utils/rh-ledger'

export const maxDuration = 60

function getWebhookSecret(): string | null {
  return process.env.RH_LEDGER_WEBHOOK_SECRET?.trim() || null
}

function isAuthorized(request: NextRequest): boolean {
  const expected = getWebhookSecret()
  if (!expected) return false
  const auth = request.headers.get('authorization')
  if (auth === `Bearer ${expected}`) return true
  const key = request.nextUrl.searchParams.get('key')
  return key === expected
}

function toEventArray(body: unknown): RhLedgerEvent[] {
  if (Array.isArray(body)) return body as RhLedgerEvent[]
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    if (Array.isArray(rec.events)) return rec.events as RhLedgerEvent[]
    if (Array.isArray(rec.records)) return rec.records as RhLedgerEvent[]
    // A single webhook delivery is typically one event object.
    return [body as RhLedgerEvent]
  }
  return []
}

/**
 * Goldsky Turbo webhook sink target. Idempotent upsert of wallet ERC-20
 * transfer rows into rh_ledger_transfers. Duplicate/replayed deliveries are
 * no-ops (ON CONFLICT DO NOTHING), so at-least-once delivery is safe.
 */
export async function POST(request: NextRequest) {
  await connection()
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body: unknown = await request.json().catch(() => null)
    const events = toEventArray(body)
    if (events.length === 0) {
      // Acknowledge empty/flush batches — a 2xx is the ack the webhook sink
      // waits for; only malformed *content* would 4xx and kill the pipeline.
      return NextResponse.json({ ok: true, events: 0, inserted: 0, skipped: 0 })
    }

    const rows = events.flatMap((e) => expandRhLedgerEvent(e))
    const { inserted, skipped } = await insertRhLedgerRows(rows)

    // Keep the tracked-wallet roster in sync with env (bound + optional parent)
    // whenever real deliveries arrive — best-effort, never fails the batch.
    if (inserted > 0) {
      void syncTrackedRhWallets().catch((err) =>
        console.warn('[rh-ledger/ingest] wallet roster sync failed:', err),
      )
    }

    return NextResponse.json({
      ok: true,
      events: events.length,
      inserted,
      skipped,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[rh-ledger/ingest] failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// GET is only reachable with the secret — handy for connectivity checks.
export async function GET(request: NextRequest) {
  await connection()
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({
    ok: true,
    usage: 'POST a robinhood_mainnet.erc20_transfers row (or array)',
  })
}
