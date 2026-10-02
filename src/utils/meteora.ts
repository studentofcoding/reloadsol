import type { MeteoraPool, MeteoraPoolsResponse } from '@/types/dlmm';
import { DLMM_CONFIG } from '@/utils/dlmm/config';

const REQUEST_TIMEOUT_MS = 8000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

let poolsCache: CacheEntry<MeteoraPool[]> | null = null;

async function meteoraFetch<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${DLMM_CONFIG.meteoraApiBase}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'reloadsol-dlmm/1.0 (+https://reloadsol.xyz)',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Meteora API ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchMeteoraPools(options?: {
  page?: number;
  limit?: number;
  sortBy?: string;
  skipCache?: boolean;
}): Promise<MeteoraPool[]> {
  const now = Date.now();
  if (!options?.skipCache && poolsCache && poolsCache.expiresAt > now) {
    return poolsCache.data;
  }

  const page = options?.page ?? 1;
  const want = options?.limit ?? 50;
  // Sort by TVL, NOT by fee/TVL. Measured 2026-10-02 against the live API:
  //   sort_by=fee_tvl_ratio_24h:desc -> tvl 0.0000, 0.0000, … 0.0001   -> 0 of 10 pass min_tvl
  //   sort_by=tvl:desc               -> tvl 37.6M, 15.3M, 12.8M …     -> 10 of 10 pass min_tvl
  // fee/tvl is fees ÷ tvl, so ranking by it descends into dust pools whose ratio is huge only because
  // the denominator is ~0. Every one of them then fails the screener's `min_tvl` floor and the screen
  // returns nothing — which is what produced 35 days of `candidateCount: 0`.
  const sortBy = options?.sortBy ?? 'tvl:desc';

  // The API IGNORES `limit` and caps `page_size` at 10 — measured: limit=10/50/100/200 all return 10
  // rows. So a single call can never deliver the requested set; walk pages until we have enough.
  const PAGE_SIZE_CAP = 10;
  const MAX_PAGES = 20;

  const collected: MeteoraPool[] = [];
  for (let p = page; collected.length < want && p - page < MAX_PAGES; p += 1) {
    const result = await meteoraFetch<MeteoraPoolsResponse>('/pools', {
      page: p,
      limit: want,
      sort_by: sortBy,
    });
    const batch = result.data ?? [];
    if (batch.length === 0) break;
    collected.push(...batch);
    // A short page means there is nothing after it.
    if (batch.length < PAGE_SIZE_CAP) break;
  }

  const pools = collected;
  poolsCache = {
    data: pools,
    expiresAt: now + DLMM_CONFIG.poolsCacheTtlMs,
  };

  return pools;
}

export async function fetchMeteoraPool(address: string): Promise<MeteoraPool> {
  return meteoraFetch<MeteoraPool>(`/pools/${address}`);
}

export async function fetchMeteoraProtocolStats(): Promise<Record<string, unknown>> {
  return meteoraFetch<Record<string, unknown>>('/stats/protocol_metrics');
}

export function estimateOrganicScore(pool: MeteoraPool): number {
  const holdersX = pool.token_x.holders ?? 0;
  const holdersY = pool.token_y.holders ?? 0;
  const holderScore = Math.min(100, Math.log10(Math.max(holdersX, holdersY, 1)) * 20);
  const feeTvl = pool.fee_tvl_ratio?.['24h'] ?? pool.apr ?? 0;
  const feeScore = Math.min(100, feeTvl * 100);
  const tvlScore = Math.min(100, Math.log10(Math.max(pool.tvl, 1)) * 15);
  return Math.round((holderScore * 0.4 + feeScore * 0.35 + tvlScore * 0.25) * 10) / 10;
}

export function getFeeTvlRatio24h(pool: MeteoraPool): number {
  return pool.fee_tvl_ratio?.['24h'] ?? pool.apr ?? 0;
}

export function getPoolVolume24h(pool: MeteoraPool): number | null {
  const volume = pool.volume?.['24h'];
  return typeof volume === 'number' && Number.isFinite(volume) ? volume : null;
}

export function getPoolMcap(pool: MeteoraPool): number {
  const xMcap = pool.token_x.market_cap ?? 0;
  const yMcap = pool.token_y.market_cap ?? 0;
  return Math.min(xMcap || Infinity, yMcap || Infinity) === Infinity
    ? Math.max(xMcap, yMcap)
    : Math.min(xMcap, yMcap);
}

export function clearMeteoraPoolsCache(): void {
  poolsCache = null;
}
