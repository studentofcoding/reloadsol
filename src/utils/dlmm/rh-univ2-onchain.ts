import { createPublicClient, http, type Address } from 'viem'
import type { RhUniv2Position } from '@/types/dlmm'
import {
  RH_CHAIN,
  erc20Abi,
  getRhRpcUrl,
  normalizeAddress,
  quoteSymbolForAddress,
} from '@/utils/dlmm/rh-univ2'
import { markRhUniv2Position } from '@/utils/dlmm/rh-univ2-mark'

export const RH_UNIV2_SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn'

const MULTICALL3 = '0xca11bde06177c9f5c1b90fd73a40a41c9d3cCA11' as Address
const PAIR_SCAN_CAP = 80

export type Univ2ShareInput = {
  owner: string
  pairId: string
  token0: string
  token1: string
  symbol0?: string | null
  symbol1?: string | null
  lpBalance: bigint
}

/** Map a non-zero UniV2 LP share onto the DAMM row shape. */
export function univ2ShareToPosition(input: Univ2ShareInput): RhUniv2Position | null {
  if (input.lpBalance <= BigInt(0)) return null
  const t0 = normalizeAddress(input.token0)
  const t1 = normalizeAddress(input.token1)
  const q0 = quoteSymbolForAddress(t0)
  const q1 = quoteSymbolForAddress(t1)
  const quoteSymbol = q0 ?? q1
  if (!quoteSymbol) return null
  const token_address = q0 ? t1 : t0
  const pair = normalizeAddress(input.pairId)
  const s0 = input.symbol0?.trim() || t0.slice(0, 6)
  const s1 = input.symbol1?.trim() || t1.slice(0, 6)
  const now = new Date(0).toISOString()
  return {
    id: `onchain:${pair}`,
    pool_address: pair,
    pair_label: `${s0}/${s1}`,
    token_address,
    quote_symbol: quoteSymbol,
    owner_address: normalizeAddress(input.owner),
    lp_token_address: pair,
    entry_quote_amount: 0,
    entry_value_usd: 0,
    current_value_usd: 0,
    pnl_pct: 0,
    status: 'open',
    add_tx: null,
    remove_tx: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
  }
}

export function mergeUniv2DbAndOnchain(
  db: readonly RhUniv2Position[],
  onchain: readonly RhUniv2Position[],
): RhUniv2Position[] {
  const openPools = new Set(
    db
      .filter((p) => p.status === 'open')
      .map((p) => p.pool_address.toLowerCase()),
  )
  const extra = onchain.filter(
    (p) => !openPools.has(p.pool_address.toLowerCase()),
  )
  return [...db, ...extra]
}

type SubgraphPairLite = {
  id: string
  token0: { id: string; symbol?: string | null }
  token1: { id: string; symbol?: string | null }
}

async function subgraphJson(query: string): Promise<unknown> {
  const res = await fetch(RH_UNIV2_SUBGRAPH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`RH subgraph HTTP ${res.status}`)
  return res.json()
}

function gqlAddr(owner: string): string {
  return normalizeAddress(owner).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function positionsFromLiquidityEntities(
  owner: string,
): Promise<Univ2ShareInput[]> {
  const user = gqlAddr(owner)
  const json = (await subgraphJson(`{
    liquidityPositions(first: 200, where: { user: "${user}" }) {
      liquidityTokenBalance
      pair {
        id
        token0 { id symbol }
        token1 { id symbol }
      }
    }
  }`)) as {
    data?: {
      liquidityPositions?: {
        liquidityTokenBalance?: string | null
        pair?: SubgraphPairLite | null
      }[]
    }
    errors?: unknown
  }
  if (json.errors || !json.data?.liquidityPositions) return []
  const out: Univ2ShareInput[] = []
  for (const row of json.data.liquidityPositions) {
    const pair = row.pair
    if (!pair?.id) continue
    const bal = Number(row.liquidityTokenBalance ?? 0)
    if (!Number.isFinite(bal) || bal <= 0) continue
    out.push({
      owner,
      pairId: pair.id,
      token0: pair.token0.id,
      token1: pair.token1.id,
      symbol0: pair.token0.symbol,
      symbol1: pair.token1.symbol,
      lpBalance: BigInt(1),
    })
  }
  return out
}

async function pairsForBalanceScan(): Promise<SubgraphPairLite[]> {
  const json = (await subgraphJson(`{
    pairs(first: ${PAIR_SCAN_CAP}, orderBy: reserveUSD, orderDirection: desc) {
      id
      token0 { id symbol }
      token1 { id symbol }
    }
  }`)) as { data?: { pairs?: SubgraphPairLite[] } }
  return json.data?.pairs ?? []
}

async function balancesOf(
  owner: Address,
  pairs: readonly SubgraphPairLite[],
): Promise<bigint[]> {
  const client = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl()),
  })
  const results = await client.multicall({
    contracts: pairs.map((p) => ({
      address: p.id as Address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    })),
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })
  return results.map((r) =>
    r.status === 'success' && typeof r.result === 'bigint' ? r.result : BigInt(0),
  )
}

async function sharesFromPairScan(owner: string): Promise<Univ2ShareInput[]> {
  const pairs = await pairsForBalanceScan()
  if (pairs.length === 0) return []
  const bals = await balancesOf(owner as Address, pairs)
  const out: Univ2ShareInput[] = []
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!
    const lpBalance = bals[i] ?? BigInt(0)
    if (lpBalance <= BigInt(0)) continue
    out.push({
      owner,
      pairId: pair.id,
      token0: pair.token0.id,
      token1: pair.token1.id,
      symbol0: pair.token0.symbol,
      symbol1: pair.token1.symbol,
      lpBalance,
    })
  }
  return out
}

export async function listOnchainRhUniv2Positions(
  owner: string,
): Promise<RhUniv2Position[]> {
  const addr = normalizeAddress(owner)
  if (!addr.startsWith('0x') || addr.length !== 42) return []

  let shares: Univ2ShareInput[] = []
  try {
    shares = await positionsFromLiquidityEntities(addr)
  } catch (e) {
    console.warn(
      '[rh-univ2] liquidityPositions query failed',
      e instanceof Error ? e.message : e,
    )
  }
  if (shares.length === 0) {
    try {
      shares = await sharesFromPairScan(addr)
    } catch (e) {
      console.warn(
        '[rh-univ2] pair balance scan failed',
        e instanceof Error ? e.message : e,
      )
      return []
    }
  }

  const rows: RhUniv2Position[] = []
  for (const share of shares) {
    const pos = univ2ShareToPosition(share)
    if (!pos) continue
    try {
      const mark = await markRhUniv2Position(pos)
      rows.push({
        ...pos,
        current_value_usd: mark.current_value_usd,
        pnl_pct: mark.pnl_pct,
        entry_value_usd: mark.current_value_usd,
      })
    } catch {
      rows.push(pos)
    }
  }
  return rows
}
