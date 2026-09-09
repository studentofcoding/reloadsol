import { NextRequest, NextResponse, connection } from 'next/server'
import {
  expandRhBalanceEvent,
  expandRhLedgerEvent,
  insertRhLedgerRows,
  syncTrackedRhWallets,
  upsertRhWalletBalances,
  type RhBalanceEvent,
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

type LedgerEvent = RhLedgerEvent & { kind?: string }

/** Balances snapshot row when it carries balance-dataset fields/kind. */
function isBalanceEvent(e: LedgerEvent): boolean {
  if (e.kind === 'balance') return true
  const rec = e as RhLedgerEvent & {
    owner_address?: unknown
    contract_address?: unknown
    token_type?: unknown
  }
  return (
    rec.owner_address != null ||
    rec.contract_address != null ||
    rec.token_type != null
  )
}

function toEventArray(body: unknown): LedgerEvent[] {
  if (Array.isArray(body)) return body as LedgerEvent[]
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    if (Array.isArray(rec.events)) return rec.events as LedgerEvent[]
    if (Array.isArray(rec.records)) return rec.records as LedgerEvent[]
    // A single webhook delivery is typically one event object.
    return [body as LedgerEvent]
  }
  return []
}

/**
 * Goldsky Turbo webhook sink target. Idempotent upserts: transfer events land
 * in rh_ledger_transfers, balances-dataset rows in rh_wallet_balances.
 * Duplicate/replayed deliveries are no-ops, so at-least-once delivery is safe.
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

    const balanceEvents: RhBalanceEvent[] = []
    const transferEvents: RhLedgerEvent[] = []
    for (const e of events) {
      if (isBalanceEvent(e)) balanceEvents.push(e)
      else transferEvents.push(e)
    }

    let inserted = 0
    let skipped = 0
    if (balanceEvents.length > 0) {
      const balRows = balanceEvents
        .map((e) => expandRhBalanceEvent(e))
        .filter((r): r is NonNullable<typeof r> => r != null)
      const { upserted } = await upsertRhWalletBalances(balRows)
      inserted += upserted
      skipped += balanceEvents.length - upserted
    }
    if (transferEvents.length > 0) {
      const rows = transferEvents.flatMap((e) => expandRhLedgerEvent(e))
      const res = await insertRhLedgerRows(rows)
      inserted += res.inserted
      skipped += res.skipped
    }

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
