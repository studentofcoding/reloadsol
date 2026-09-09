import { query } from '@/utils/db'
import type { UserToken } from '@/utils/jupiter'
import {
  fetchRhTokenMeta,
  fillMissingRhUsd,
  isEvmAddress,
  isRhHeldToken,
  sortRhTokensByUsd,
} from '@/utils/rh-wallet-holdings'

// ---------------------------------------------------------------------------
// Goldsky RH wallet ledger. Rows are ERC-20 Transfer events touching a tracked
// Robinhood wallet, streamed by the Turbo pipeline `reloadsol-rh-wallet-ledger`
// (robinhood_mainnet.erc20_transfers) into POST /api/rh/ledger/ingest.
//
// One chain event expands into two ledger rows (sender-side "out" + recipient-
// side "in"); each row is idempotent on its own composite primary key, so
// Goldsky at-least-once delivery and reorg replays simply no-op on duplicates.
// Holdings/history queries filter by wallet_address, so wallets are tracked
// without any server-side allowlist.
// ---------------------------------------------------------------------------

/** A single Goldsky `erc20_transfers` dataset row (as delivered by webhook). */
export type RhLedgerEvent = {
  id?: string
  address?: string // token contract
  sender?: string
  recipient?: string
  amount?: string | number
  block_number?: number | string
  block_timestamp?: number | string
  transaction_hash?: string
  log_index?: number | string
}

/** One ledger row — the transfer as seen from one wallet's side. */
export type RhLedgerRow = {
  id: string
  wallet_address: string
  direction: 'in' | 'out'
  token_address: string
  counterparty: string
  amount_raw: string
  block_number: number
  block_timestamp: Date
  tx_hash: string
  log_index: number
}

export type RhLedgerInsertResult = { inserted: number; skipped: number }

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/

function parseAmountRaw(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null
  const clean = s.split('.')[0]
  if (clean === '0' || /^0+$/.test(clean)) return null // zero/empty transfers
  return clean
}

function parseBlockTs(v: unknown): Date | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  // unix seconds (dataset) or millis — normalize: >1e12 treat as millis
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Pure: expand one chain event into ledger rows (0–2). Self-transfers and
 * malformed rows are dropped. Exported separately for unit tests.
 */
export function expandRhLedgerEvent(event: RhLedgerEvent): RhLedgerRow[] {
  const token = String(event.address ?? '').trim().toLowerCase()
  const sender = String(event.sender ?? '').trim().toLowerCase()
  const recipient = String(event.recipient ?? '').trim().toLowerCase()
  const txHash = String(event.transaction_hash ?? '').trim().toLowerCase()
  const amount = parseAmountRaw(event.amount)
  const ts = parseBlockTs(event.block_timestamp)
  const blockNumber = Number(event.block_number)
  const logIndex = Number(event.log_index)

  if (!isEvmAddress(token) || !isEvmAddress(sender) || !isEvmAddress(recipient))
    return []
  if (!amount || !ts || sender === recipient) return []
  if (!Number.isInteger(blockNumber) || blockNumber <= 0) return []
  if (!Number.isInteger(logIndex) || logIndex < 0) return []
  if (!txHash || !TX_HASH_RE.test(txHash)) return []

  const rows: RhLedgerRow[] = [
    {
      id: `${txHash}:${logIndex}:out`,
      wallet_address: sender,
      direction: 'out',
      token_address: token,
      counterparty: recipient,
      amount_raw: amount,
      block_number: blockNumber,
      block_timestamp: ts,
      tx_hash: txHash,
      log_index: logIndex,
    },
    {
      id: `${txHash}:${logIndex}:in`,
      wallet_address: recipient,
      direction: 'in',
      token_address: token,
      counterparty: sender,
      amount_raw: amount,
      block_number: blockNumber,
      block_timestamp: ts,
      tx_hash: txHash,
      log_index: logIndex,
    },
  ]
  return rows
}

const LEDGER_COLUMNS =
  'id, wallet_address, direction, token_address, counterparty, ' +
  'amount_raw, block_number, block_timestamp, tx_hash, log_index'

/** Chunked idempotent insert (Goldsky webhook replays just no-op). */
export async function insertRhLedgerRows(
  rows: RhLedgerRow[],
  opts?: { chunkSize?: number },
): Promise<RhLedgerInsertResult> {
  const chunkSize = opts?.chunkSize ?? 200
  let inserted = 0
  let skipped = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    if (chunk.length === 0) continue
    const params: unknown[] = []
    const valuesSql: string[] = []
    for (const r of chunk) {
      const base = params.length
      valuesSql.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
      )
      params.push(
        r.id,
        r.wallet_address,
        r.direction,
        r.token_address,
        r.counterparty,
        r.amount_raw,
        r.block_number,
        r.block_timestamp.toISOString(),
        r.tx_hash,
        r.log_index,
      )
    }
    const { rowCount } = await query(
      `INSERT INTO rh_ledger_transfers (${LEDGER_COLUMNS}) VALUES ${valuesSql.join(', ')} ` +
        `ON CONFLICT (id) DO NOTHING`,
      params,
    )
    inserted += rowCount
    skipped += chunk.length - rowCount
  }
  return { inserted, skipped }
}

export type RhHolding = { token_address: string; net_raw: string }

/**
 * Current per-token net balance from the ledger (raw base units). Computed in
 * SQL with exact NUMERIC math, returned as a string so JS never loses big-integer
 * precision before applying decimals.
 */
export async function listRhLedgerHoldings(
  wallet: string,
): Promise<RhHolding[]> {
  const { rows } = await query<{ token_address: string; net_raw: string }>(
    `SELECT token_address,
            SUM(CASE WHEN direction = 'in' THEN amount_raw ELSE -amount_raw END)::text AS net_raw
     FROM rh_ledger_transfers
     WHERE wallet_address = $1
     GROUP BY token_address
     HAVING SUM(CASE WHEN direction = 'in' THEN amount_raw ELSE -amount_raw END) > 0`,
    [wallet.toLowerCase()],
  )
  return rows.map((r) => ({
    token_address: r.token_address,
    net_raw: r.net_raw,
  }))
}

export type RhTokenMetaRow = {
  token_address: string
  symbol: string | null
  name: string | null
  decimals: number | null
  logo_url: string | null
  source: string
}

async function selectTokenMeta(
  addresses: string[],
): Promise<Map<string, RhTokenMetaRow>> {
  if (addresses.length === 0) return new Map()
  const { rows } = await query<RhTokenMetaRow>(
    `SELECT token_address, symbol, name, decimals, logo_url, source
     FROM rh_token_meta
     WHERE token_address = ANY($1::text[])`,
    [addresses],
  )
  return new Map(rows.map((r) => [r.token_address, r]))
}

/**
 * Ensure every token has a `rh_token_meta` row (fetching missing metadata from
 * Blockscout/GMGN) and return the full metadata map. Unknown tokens are simply
 * absent from the map.
 */
export async function ensureRhTokenMeta(
  addresses: string[],
): Promise<Map<string, RhTokenMetaRow>> {
  const unique = Array.from(
    new Set(addresses.map((a) => a.toLowerCase()).filter(isEvmAddress)),
  )
  if (unique.length === 0) return new Map()

  const known = await selectTokenMeta(unique)
  const missing = unique.filter((a) => !known.has(a))
  if (missing.length === 0) return known

  const CONCURRENCY = 3
  const fetched: RhTokenMetaRow[] = []
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const chunk = missing.slice(i, i + CONCURRENCY)
    const metas = await Promise.all(
      chunk.map(async (addr) => {
        try {
          const m = await fetchRhTokenMeta(addr)
          if (!m) return null
          return {
            token_address: m.address,
            symbol: m.symbol ?? null,
            name: m.name ?? null,
            decimals: m.decimals ?? null,
            logo_url: m.logoURI ?? null,
            source: 'blockscout',
          } satisfies RhTokenMetaRow
        } catch (err) {
          console.warn('[rh-ledger] token meta fetch failed:', addr, err)
          return null
        }
      }),
    )
    for (const m of metas) if (m) fetched.push(m)
  }

  for (let i = 0; i < fetched.length; i += 50) {
    const chunk = fetched.slice(i, i + 50)
    const params: unknown[] = []
    const valuesSql: string[] = []
    for (const m of chunk) {
      const base = params.length
      valuesSql.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      )
      params.push(m.token_address, m.symbol, m.name, m.decimals, m.logo_url, m.source)
    }
    await query(
      `INSERT INTO rh_token_meta (token_address, symbol, name, decimals, logo_url, source, updated_at)
       VALUES ${valuesSql.join(', ')}
       ON CONFLICT (token_address) DO UPDATE SET
         symbol = COALESCE(EXCLUDED.symbol, rh_token_meta.symbol),
         name = COALESCE(EXCLUDED.name, rh_token_meta.name),
         decimals = COALESCE(EXCLUDED.decimals, rh_token_meta.decimals),
         logo_url = COALESCE(EXCLUDED.logo_url, rh_token_meta.logo_url),
         source = EXCLUDED.source,
         updated_at = NOW()`,
      params,
    )
  }

  for (const m of fetched) known.set(m.token_address, m)
  return known
}

export type RhLedgerHistoryRow = RhLedgerRow & {
  amount_ui: number
  symbol: string | null
  decimals: number | null
}

/** Recent transfer events for a wallet (optionally one token), newest first. */
export async function listRhLedgerHistory(
  wallet: string,
  opts?: { token?: string; limit?: number },
): Promise<RhLedgerHistoryRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200)
  const token = opts?.token?.trim().toLowerCase()
  const params: unknown[] = [wallet.toLowerCase(), limit]
  let tokenClause = ''
  if (token && isEvmAddress(token)) {
    tokenClause = 'AND token_address = $3'
    params.push(token)
  }

  const { rows } = await query<RhLedgerRow>(
    `SELECT id, wallet_address, direction, token_address, counterparty,
            amount_raw, block_number, block_timestamp, tx_hash, log_index
     FROM rh_ledger_transfers
     WHERE wallet_address = $1 ${tokenClause}
     ORDER BY block_number DESC, log_index DESC
     LIMIT $2`,
    params,
  )
  if (rows.length === 0) return []

  const meta = await ensureRhTokenMeta(rows.map((r) => r.token_address))
  return rows.map((r) => {
    const m = meta.get(r.token_address)
    const decimals = m?.decimals ?? null
    const raw = Number(r.amount_raw)
    return {
      ...r,
      amount_ui:
        decimals != null && decimals > 0 && Number.isFinite(raw)
          ? raw / 10 ** decimals
          : Number.isFinite(raw)
            ? raw
            : 0,
      symbol: m?.symbol ?? null,
      decimals,
    }
  })
}

/**
 * Ledger-backed current holdings as UserToken rows (decimals applied, USD
 * filled via the shared cached GMGN price path). Throws on DB errors so the
 * caller can fall back to the indexer ladder.
 */
export async function fetchRhLedgerHoldings(
  wallet: string,
  opts?: { maxUsdFill?: number },
): Promise<UserToken[]> {
  const holdings = await listRhLedgerHoldings(wallet)
  if (holdings.length === 0) return []

  const meta = await ensureRhTokenMeta(holdings.map((h) => h.token_address))

  const tokens: UserToken[] = []
  for (const h of holdings) {
    const m = meta.get(h.token_address)
    if (!m || m.decimals == null) {
      console.warn('[rh-ledger] holding without decimals, skipping:', h.token_address)
      continue
    }
    const decimals = m.decimals
    const raw = Number(h.net_raw)
    const uiAmount = decimals > 0 && Number.isFinite(raw) ? raw / 10 ** decimals : raw
    if (!isRhHeldToken({ uiAmount })) continue
    tokens.push({
      mintAddress: h.token_address,
      balance: raw,
      decimals,
      symbol: m.symbol ?? '???',
      name: m.name ?? m.symbol ?? 'Unknown',
      logoURI: m.logo_url ?? undefined,
      uiAmount,
      usdValue: 0,
      isNFT: false,
    })
  }

  if (tokens.length > 0) {
    const priced = await fillMissingRhUsd(tokens, { cap: opts?.maxUsdFill })
    return sortRhTokensByUsd(priced)
  }
  return []
}

/** Env-seeded list of tracked RH wallets (informational). */
export async function syncTrackedRhWallets(): Promise<string[]> {
  const candidates: Array<{ address: string; label: string }> = []
  const bound = process.env.GMGN_BOUND_EVM_ADDRESS?.trim()
  const parent = process.env.RH_TRACKED_PARENT_ADDRESS?.trim()
  if (bound && isEvmAddress(bound)) candidates.push({ address: bound.toLowerCase(), label: 'bound' })
  if (parent && isEvmAddress(parent)) candidates.push({ address: parent.toLowerCase(), label: 'parent' })
  if (candidates.length === 0) return []

  const params: unknown[] = []
  const valuesSql: string[] = []
  for (const c of candidates) {
    const base = params.length
    valuesSql.push(`($${base + 1}, $${base + 2})`)
    params.push(c.address, c.label)
  }
  await query(
    `INSERT INTO tracked_rh_wallets (wallet_address, label) VALUES ${valuesSql.join(', ')}
     ON CONFLICT (wallet_address) DO UPDATE SET label = EXCLUDED.label`,
    params,
  )
  return candidates.map((c) => c.address)
}
