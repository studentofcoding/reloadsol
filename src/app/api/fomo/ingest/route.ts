import { NextRequest, NextResponse, connection } from 'next/server'
import { bulkInsert, query, queryOne } from '@/utils/db'
import {
  isServiceAuthorizedRequest,
  requireDevSession,
} from '@/utils/api-auth'
import { insertSocialEvents } from '@/strategies/social/db'
import {
  fomoFillToSocialEvent,
  maxFillsPerBatch,
  normalizeFomoFill,
  type NormalizedFomoFill,
} from '@/utils/fomo-fills'

type HelloPayload = {
  lag_seconds?: unknown
  last_block?: unknown
  viewers?: unknown
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const FILL_COLUMNS = [
  { name: 'source_fill_id', type: 'bigint' },
  { name: 'tx', type: 'text' },
  { name: 'wallet_address', type: 'text' },
  { name: 'token_address', type: 'text' },
  { name: 'symbol', type: 'text' },
  { name: 'name', type: 'text' },
  { name: 'handle', type: 'text' },
  { name: 'side', type: 'text' },
  { name: 'usd', type: 'numeric' },
  { name: 'amount', type: 'numeric' },
  { name: 'price', type: 'numeric' },
  { name: 'mark', type: 'numeric' },
  { name: 'liquidity', type: 'numeric' },
  { name: 'followers', type: 'bigint' },
  { name: 'new_position', type: 'boolean' },
  { name: 'is_stock', type: 'boolean' },
  { name: 'priced', type: 'text' },
  { name: 'block', type: 'bigint' },
  { name: 'pair_url', type: 'text' },
  { name: 'flags', type: 'jsonb' },
  { name: 'raw', type: 'jsonb' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'chain', type: 'text' },
] as const

function fillRow(f: NormalizedFomoFill): unknown[] {
  return [
    f.source_fill_id,
    f.tx,
    f.wallet_address,
    f.token_address,
    f.symbol,
    f.name,
    f.handle,
    f.side,
    f.usd,
    f.amount,
    f.price,
    f.mark,
    f.liquidity,
    f.followers,
    f.new_position,
    f.is_stock,
    f.priced,
    f.block,
    f.pair_url,
    f.flags == null ? null : JSON.stringify(f.flags),
    JSON.stringify(f.raw),
    f.occurred_at,
    f.chain,
  ]
}

async function upsertHello(hello: HelloPayload | null | undefined): Promise<void> {
  if (!hello || typeof hello !== 'object') return
  const lag = asFiniteNumber(hello.lag_seconds)
  const lastBlock = asFiniteNumber(hello.last_block)
  const viewers = asFiniteNumber(hello.viewers)
  await query(
    `INSERT INTO fomo_indexer_status (id, lag_seconds, last_block, viewers, last_hello_at, raw_hello, updated_at)
     VALUES (1, $1, $2, $3, NOW(), $4::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       lag_seconds = COALESCE(EXCLUDED.lag_seconds, fomo_indexer_status.lag_seconds),
       last_block = COALESCE(EXCLUDED.last_block, fomo_indexer_status.last_block),
       viewers = COALESCE(EXCLUDED.viewers, fomo_indexer_status.viewers),
       last_hello_at = EXCLUDED.last_hello_at,
       raw_hello = EXCLUDED.raw_hello,
       updated_at = NOW()`,
    [lag, lastBlock, viewers == null ? null : Math.trunc(viewers), JSON.stringify(hello)],
  )
}

async function loadFomoSkipWallets(): Promise<Set<string>> {
  const set = new Set<string>()
  for (const sql of [
    `SELECT lower(address) AS a FROM alpha_wallet_roster`,
    `SELECT lower(address) AS a FROM tracked_wallets`,
  ]) {
    try {
      const { rows } = await query<{ a: string }>(sql)
      for (const row of rows) {
        const a = row.a?.trim()
        if (a) set.add(a)
      }
    } catch {
      // ponytail: missing roster table → fan all cash_leg; overlap risk until tables exist
    }
  }
  return set
}

async function bumpIngestStatus(maxId: number | null): Promise<void> {
  await query(
    `INSERT INTO fomo_indexer_status (id, last_fill_id, last_ingest_at, updated_at)
     VALUES (1, $1, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_fill_id = GREATEST(COALESCE(fomo_indexer_status.last_fill_id, 0), COALESCE(EXCLUDED.last_fill_id, 0)),
       last_ingest_at = NOW(),
       updated_at = NOW()`,
    [maxId],
  )
}

export async function GET(request: NextRequest) {
  await connection()
  if (!isServiceAuthorizedRequest(request)) {
    const auth = requireDevSession(request)
    if (auth instanceof NextResponse) return auth
  }

  try {
    const status = await queryOne<{
      lag_seconds: number | null
      last_block: string | number | null
      last_fill_id: string | number | null
      last_hello_at: string | null
      last_ingest_at: string | null
      viewers: number | null
    }>(`SELECT lag_seconds, last_block, last_fill_id, last_hello_at, last_ingest_at, viewers
        FROM fomo_indexer_status WHERE id = 1`)

    const maxRow = await queryOne<{ max_id: string | number | null }>(
      `SELECT MAX(source_fill_id) AS max_id FROM fomo_fills`,
    )
    const countRow = await queryOne<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM fomo_fills WHERE created_at > NOW() - INTERVAL '1 minute'`,
    )

    const lastFillId = Number(status?.last_fill_id ?? maxRow?.max_id ?? 0) || 0
    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? '50')
    const fillLimit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 0), 200)
      : 50

    let fills: Array<Record<string, unknown>> = []
    if (fillLimit > 0) {
      try {
        const { rows } = await query<Record<string, unknown>>(
          `SELECT source_fill_id, occurred_at, side, handle, wallet_address,
                  token_address, symbol, usd, priced, is_stock, tx
           FROM fomo_fills
           ORDER BY occurred_at DESC
           LIMIT $1`,
          [fillLimit],
        )
        fills = rows
      } catch {
        fills = []
      }
    }

    return NextResponse.json({
      success: true,
      last_fill_id: lastFillId,
      lag_seconds: status?.lag_seconds ?? null,
      last_block: status?.last_block != null ? Number(status.last_block) : null,
      last_hello_at: status?.last_hello_at ?? null,
      last_ingest_at: status?.last_ingest_at ?? null,
      viewers: status?.viewers ?? null,
      fills_per_min: Number(countRow?.n ?? 0) || 0,
      fills,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Health failed',
      },
      { status: 503 },
    )
  }
}

export async function POST(request: NextRequest) {
  if (!isServiceAuthorizedRequest(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body: { fills?: unknown; hello?: HelloPayload }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const cap = maxFillsPerBatch()
  const rawFills = Array.isArray(body.fills) ? body.fills.slice(0, cap) : []
  const normalized: NormalizedFomoFill[] = []
  const seen = new Set<number>()
  for (const raw of rawFills) {
    const fill = normalizeFomoFill(raw)
    if (!fill || seen.has(fill.source_fill_id)) continue
    seen.add(fill.source_fill_id)
    normalized.push(fill)
  }

  try {
    const stats =
      normalized.length === 0
        ? { rows: 0, chunks: 0, ms: 0 }
        : await bulkInsert({
            table: 'fomo_fills',
            columns: [...FILL_COLUMNS],
            rows: normalized.map(fillRow),
            conflictTarget: '(source_fill_id)',
          })

    const maxId =
      normalized.length === 0
        ? null
        : Math.max(...normalized.map((f) => f.source_fill_id))

    await upsertHello(body.hello)
    if (normalized.length > 0 || body.hello) {
      await bumpIngestStatus(maxId)
    }

    let social = { inserted: 0, skipped: 0 }
    try {
      const skipWallets = await loadFomoSkipWallets()
      const events = normalized
        .map((f) => fomoFillToSocialEvent(f, skipWallets))
        .filter((e): e is NonNullable<typeof e> => e != null)
      social = await insertSocialEvents(events)
    } catch {
      // Mirror must not die if social_token_events is down.
    }

    return NextResponse.json({
      success: true,
      received: rawFills.length,
      inserted_attempted: normalized.length,
      last_fill_id: maxId,
      ms: stats.ms,
      social_inserted: social.inserted,
      social_skipped: social.skipped,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Ingest failed',
      },
      { status: 500 },
    )
  }
}
