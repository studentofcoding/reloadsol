import { query } from '@/utils/db'
import type { UserToken } from '@/utils/jupiter'
import {
  fetchRhTokenMeta,
  fillMissingRhUsd,
} from '@/utils/rh-usd-meta'
import {
  isEvmAddress,
  isRhHeldToken,
  sortRhTokensByUsd,
} from '@/utils/rh-wallet-holdings'
import { createPublicClient, http } from 'viem'
import { RH_CHAIN, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'

// ---------------------------------------------------------------------------
// Ledger readiness: holdings derived from the transfer ledger are only correct
// once the pipeline has caught up to the chain tip (backfill done, tail
// streaming). While it is mid-backfill the net would be partial/wrong, so the
// route falls back to the indexer/RPC ladder instead.
// ---------------------------------------------------------------------------

/** Blocks of slack allowed before we call the ledger "caught up". */
const LEDGER_CATCHUP_SLACK = 3000

let cachedTip: { at: number; tip: number } | null = null

async function getChainTip(): Promise<number> {
  const now = Date.now()
  if (cachedTip && now - cachedTip.at < 30_000) return cachedTip.tip
  const client = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl(), { timeout: 8000 }),
  })
  const tip = Number(await client.getBlockNumber())
  cachedTip = { at: now, tip }
  return tip
}

/**
 * True when the ledger's newest row (any tracked wallet) is within a few
 * minutes of the chain tip — i.e. the backfill completed and the tail is live.
 * False during the one-time genesis→tip backfill or when the DB is empty.
 */
export async function isRhLedgerCaughtUp(): Promise<boolean> {
  try {
    const row = await query<{ last: string | null }>(
      'SELECT MAX(block_number)::text AS last FROM rh_ledger_transfers',
    )
    const last = row.rows[0]?.last
    if (!last || Number(last) <= 0) return false
    const tip = await getChainTip()
    return tip - Number(last) <= LEDGER_CATCHUP_SLACK
  } catch {
    return false
  }
}

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

/** Like parseAmountRaw but keeps "0" — balance snapshots need zero rows. */
function parseBalanceRaw(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null
  return s.split('.')[0]
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

/** A robinhood_mainnet.balances dataset row (current ERC-20 balance). */
export type RhBalanceEvent = {
  id?: string
  owner_address?: string
  contract_address?: string
  token_id?: string | null
  token_type?: string
  balance?: string | number
  block_number?: number | string
  block_timestamp?: number | string
}

export type RhBalanceRow = {
  owner_address: string
  token_address: string
  balance_raw: string
  block_number: number
  block_timestamp: Date
}

/**
 * Pure: normalize one balances row into a snapshot row. Only plain ERC-20
 * (no token_id) balances are tracked; malformed/empty balances are dropped.
 */
export function expandRhBalanceEvent(event: RhBalanceEvent): RhBalanceRow | null {
  const owner = String(event.owner_address ?? '').trim().toLowerCase()
  const token = String(event.contract_address ?? '').trim().toLowerCase()
  const type = String(event.token_type ?? '').toUpperCase()
  const tokenId = event.token_id == null ? '' : String(event.token_id).trim()
  const amount = parseBalanceRaw(event.balance)
  const ts = parseBlockTs(event.block_timestamp)
  const blockNumber = Number(event.block_number)

  if (!isEvmAddress(owner) || !isEvmAddress(token)) return null
  if (type !== 'ERC_20' || (tokenId && tokenId !== 'null' && tokenId !== '')) return null
  if (!amount || !ts) return null
  if (!Number.isInteger(blockNumber) || blockNumber <= 0) return null
  return {
    owner_address: owner,
    token_address: token,
    balance_raw: amount,
    block_number: blockNumber,
    block_timestamp: ts,
  }
}

/** Upsert current balances (last-write-wins, newest block). */
export async function upsertRhWalletBalances(
  rows: RhBalanceRow[],
  opts?: { chunkSize?: number },
): Promise<{ upserted: number }> {
  // The balances dataset can deliver multiple updates for the same
  // wallet+token inside one webhook batch — dedupe keeping the newest block
  // (a single statement can't ON CONFLICT-update the same key twice).
  const latest = new Map<string, RhBalanceRow>()
  for (const r of rows) {
    const key = `${r.owner_address}|${r.token_address}`
    const prev = latest.get(key)
    if (!prev || r.block_number >= prev.block_number) latest.set(key, r)
  }
  const deduped = Array.from(latest.values())

  const chunkSize = opts?.chunkSize ?? 200
  let upserted = 0
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const chunk = deduped.slice(i, i + chunkSize)
    if (chunk.length === 0) continue
    const params: unknown[] = []
    const valuesSql: string[] = []
    for (const r of chunk) {
      const base = params.length
      valuesSql.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
      )
      params.push(
        r.owner_address,
        r.token_address,
        r.balance_raw,
        r.block_number,
        r.block_timestamp.toISOString(),
      )
    }
    const { rowCount } = await query(
      `INSERT INTO rh_wallet_balances
         (owner_address, token_address, balance_raw, block_number, block_timestamp)
       VALUES ${valuesSql.join(', ')}
       ON CONFLICT (owner_address, token_address) DO UPDATE SET
         balance_raw = EXCLUDED.balance_raw,
         block_number = EXCLUDED.block_number,
         block_timestamp = EXCLUDED.block_timestamp,
         updated_at = NOW()`,
      params,
    )
    upserted += rowCount
  }
  return { upserted }
}

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
  dust_blacklisted: boolean
  blacklisted_at: Date | null
}

/** Dust blacklist validity window — re-evaluate entries after this long. */
export const RH_DUST_BLACKLIST_TTL_HOURS = 24

/** Tokens currently blacklisted as confirmed dust (sub-cent holdings). */
export async function listRhDustBlacklist(): Promise<Set<string>> {
  const { rows } = await query<{ token_address: string }>(
    `SELECT token_address FROM rh_token_meta
     WHERE dust_blacklisted = true
       AND (blacklisted_at IS NULL OR blacklisted_at > NOW() - INTERVAL '${RH_DUST_BLACKLIST_TTL_HOURS} hours')`,
  )
  return new Set(rows.map((r) => r.token_address.toLowerCase()))
}

/** Persist "confirmed dust" so future requests skip these tokens cheaply. */
export async function markRhTokenDust(addresses: string[]): Promise<void> {
  const unique = Array.from(
    new Set(
      addresses.map((a) => a.toLowerCase()).filter((a) => isEvmAddress(a)),
    ),
  )
  if (unique.length === 0) return
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50)
    const params: unknown[] = []
    const valuesSql: string[] = []
    for (const a of chunk) {
      const base = params.length
      valuesSql.push(`($${base + 1})`)
      params.push(a)
    }
    await query(
      `INSERT INTO rh_token_meta (token_address, dust_blacklisted, blacklisted_at)
       VALUES ${valuesSql.join(', ')}
       ON CONFLICT (token_address) DO UPDATE SET
         dust_blacklisted = true,
         blacklisted_at = NOW()`,
      params,
    )
  }
}

async function selectTokenMeta(
  addresses: string[],
): Promise<Map<string, RhTokenMetaRow>> {
  if (addresses.length === 0) return new Map()
  const { rows } = await query<RhTokenMetaRow>(
    `SELECT token_address, symbol, name, decimals, logo_url, source,
            dust_blacklisted, blacklisted_at
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
            dust_blacklisted: false,
            blacklisted_at: null,
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
      `INSERT INTO rh_token_meta (token_address, symbol, name, decimals, logo_url, source)
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

  // Last-resort metadata: ERC-20 `decimals()` straight from the chain for
  // tokens the explorers/GMGN don't know (e.g. obscure RH holdings). Without
  // decimals the balance rows can't be displayed at all.
  const stillMissing = unique.filter((a) => !known.has(a))
  if (stillMissing.length > 0) {
    const client = createPublicClient({
      chain: RH_CHAIN,
      transport: http(getRhRpcUrl(), { timeout: 8000 }),
    })
    const DECIMALS_ABI = [
      {
        type: 'function',
        name: 'decimals',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint8' }],
      },
    ] as const
    const SYMBOL_ABI = [
      {
        type: 'function',
        name: 'symbol',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'string' }],
      },
    ] as const
    const onchain: RhTokenMetaRow[] = []
    for (let i = 0; i < stillMissing.length; i += 3) {
      const chunk = stillMissing.slice(i, i + 3)
      const res = await Promise.all(
        chunk.map(async (addr) => {
          try {
            const dec = await client.readContract({
              address: addr as `0x${string}`,
              abi: DECIMALS_ABI,
              functionName: 'decimals',
            })
            let symbol: string | null = null
            try {
              const sym = await client.readContract({
                address: addr as `0x${string}`,
                abi: SYMBOL_ABI,
                functionName: 'symbol',
              })
              if (typeof sym === 'string' && sym.trim()) {
                symbol = sym.trim().slice(0, 24)
              }
            } catch {
              // non-standard token without symbol() — decimals alone suffice
            }
            return {
              token_address: addr,
              symbol,
              name: symbol,
              decimals: Number(dec),
              logo_url: null,
              source: 'rpc',
              dust_blacklisted: false,
              blacklisted_at: null,
            } satisfies RhTokenMetaRow
          } catch {
            return null
          }
        }),
      )
      for (const m of res) if (m) onchain.push(m)
    }
    if (onchain.length > 0) {
      const params: unknown[] = []
      const valuesSql: string[] = []
      for (const m of onchain) {
        const base = params.length
        valuesSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
        )
        params.push(m.token_address, m.symbol, m.name, m.decimals, m.source)
      }
      await query(
        `INSERT INTO rh_token_meta (token_address, symbol, name, decimals, source)
         VALUES ${valuesSql.join(', ')}
         ON CONFLICT (token_address) DO UPDATE SET
           symbol = COALESCE(EXCLUDED.symbol, rh_token_meta.symbol),
           name = COALESCE(EXCLUDED.name, rh_token_meta.name),
           decimals = COALESCE(EXCLUDED.decimals, rh_token_meta.decimals),
           updated_at = NOW()`,
        params,
      )
      for (const m of onchain) known.set(m.token_address, m)
    }
  }

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

type HoldingEntry = { token_address: string; raw: string }

/**
 * Shared: entries (token + raw balance) → UserToken rows with decimals from
 * rh_token_meta, USD via the cached GMGN fill, dust/`???` rules applied.
 */
async function entriesToRhUserTokens(
  entries: HoldingEntry[],
  opts?: { maxUsdFill?: number },
): Promise<UserToken[]> {
  if (entries.length === 0) return []
  const meta = await ensureRhTokenMeta(entries.map((e) => e.token_address))

  const tokens: UserToken[] = []
  for (const h of entries) {
    const m = meta.get(h.token_address)
    if (!m || m.decimals == null) {
      console.warn(
        '[rh-ledger] holding without decimals, skipping:',
        h.token_address,
      )
      continue
    }
    const decimals = m.decimals
    const raw = Number(h.raw)
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

/**
 * Ledger-backed current holdings as UserToken rows (decimals applied, USD
 * filled via the shared cached GMGN price path). Throws on DB errors so the
 * caller can fall back to the indexer ladder.
 */
export async function fetchRhLedgerHoldings(
  wallet: string,
  opts?: { maxUsdFill?: number },
): Promise<UserToken[]> {
  // Partial backfill nets are wrong — only serve ledger truth once the
  // pipeline rows are near the chain tip (backfill done + tail live).
  if (!(await isRhLedgerCaughtUp())) return []
  const holdings = await listRhLedgerHoldings(wallet)
  return entriesToRhUserTokens(
    holdings.map((h) => ({ token_address: h.token_address, raw: h.net_raw })),
    opts,
  )
}

/**
 * Exact current holdings from the Goldsky balances snapshot table — no history
 * required, so tokens the app never saw (manual Rabby buys etc.) still show.
 * Returns [] when the wallet has no rows yet (stream not started).
 */
export async function fetchRhBalanceHoldings(
  wallet: string,
  opts?: { maxUsdFill?: number },
): Promise<UserToken[]> {
  const { rows } = await query<{ token_address: string; balance_raw: string }>(
    `SELECT token_address, balance_raw::text AS balance_raw
     FROM rh_wallet_balances
     WHERE owner_address = $1 AND balance_raw > 0`,
    [wallet.toLowerCase()],
  )
  return entriesToRhUserTokens(
    rows.map((r) => ({ token_address: r.token_address, raw: r.balance_raw })),
    opts,
  )
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
