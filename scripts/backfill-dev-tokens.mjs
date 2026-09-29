#!/usr/bin/env node
/**
 * Backfill the top-tokens list on dev_reputation rows that predate the column.
 *
 * Re-runnable and idempotent: it only touches rows whose `tokens` array is empty,
 * so a second run is a no-op. Dry-run by default; pass --apply to write.
 *
 * Reads GMGN created_tokens (exist-auth: API key only). Must run where
 * DATABASE_URL + GMGN_API_KEY resolve (the reloadsol-web container).
 *
 *   node scripts/backfill-dev-tokens.mjs            # dry run
 *   node scripts/backfill-dev-tokens.mjs --apply    # write
 */

import { Client } from 'pg'

const APPLY = process.argv.includes('--apply')
const PACE_MS = Number(process.env.BACKFILL_PACE_MS ?? 700)
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? 500)
const HOST = process.env.GMGN_API_HOST?.trim() || 'https://openapi.gmgn.ai'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** Top-N by ATH, mirroring src/strategies/dev-reputation.ts topDevTokens. */
function topDevTokens(rows, n = 10) {
  const out = []
  for (const row of rows) {
    const address = str(row.token_address)
    if (!address) continue
    out.push({
      address,
      symbol: str(row.symbol),
      athMc: toNum(row.token_ath_mc),
      marketCap: toNum(row.market_cap),
      liquidity: toNum(row.pool_liquidity),
      holders: toNum(row.holders),
      graduated: row.is_open === true,
      launchpad: str(row.launchpad_platform),
      createdAt: toNum(row.create_timestamp),
    })
  }
  return out.sort((a, b) => (b.athMc ?? -1) - (a.athMc ?? -1)).slice(0, Math.max(0, n))
}

async function fetchCreatedTokens(chain, wallet, apiKey) {
  const params = new URLSearchParams({
    chain,
    wallet_address: chain === 'sol' ? wallet : wallet.toLowerCase(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: crypto.randomUUID(),
  })
  const res = await fetch(`${HOST}/v1/user/created_tokens?${params}`, {
    headers: { Accept: 'application/json', 'X-APIKEY': apiKey },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`http ${res.status}`)
  const json = JSON.parse(text)
  if (json.code !== 0 && json.code !== '0') throw new Error(json.message || `code ${json.code}`)
  return json.data ?? json
}

async function main() {
  const { DATABASE_URL, GMGN_API_KEY } = process.env
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!GMGN_API_KEY) throw new Error('GMGN_API_KEY is required')

  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `SELECT chain, creator_address FROM dev_reputation
     WHERE jsonb_array_length(tokens) = 0
     ORDER BY evaluated_at DESC LIMIT $1`,
    [LIMIT],
  )
  console.log(`rows needing tokens: ${rows.length} | mode: ${APPLY ? 'APPLY' : 'dry-run'}`)

  let ok = 0
  let failed = 0
  for (const { chain, creator_address } of rows) {
    try {
      const data = await fetchCreatedTokens(chain, creator_address, GMGN_API_KEY)
      const tokens = topDevTokens(data.tokens ?? [], 10)
      if (APPLY) {
        await client.query(
          `UPDATE dev_reputation SET tokens = $3::jsonb WHERE chain = $1 AND creator_address = $2`,
          [chain, creator_address, JSON.stringify(tokens)],
        )
      }
      ok++
      console.log(`${APPLY ? 'wrote' : 'would write'} ${creator_address.slice(0, 8)}… tokens=${tokens.length}`)
    } catch (err) {
      failed++
      console.log(`skip ${creator_address.slice(0, 8)}…: ${err.message}`)
    }
    await sleep(PACE_MS)
  }

  console.log(`done: ok=${ok} failed=${failed}`)
  await client.end()
}

main().catch((err) => {
  console.error('backfill failed:', err.message)
  process.exit(1)
})
