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
  const limit = options?.limit ?? 50;
  const sortBy = options?.sortBy ?? 'fee_tvl_ratio_24h:desc';

  const result = await meteoraFetch<MeteoraPoolsResponse>('/pools', {
    page,
    limit,
    sort_by: sortBy,
  });

  const pools = result.data ?? [];
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
