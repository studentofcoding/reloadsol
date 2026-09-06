import type { DlmmScreenCandidate } from '@/types/dlmm';
import {
  estimateOrganicScore,
  fetchMeteoraPools,
  getFeeTvlRatio24h,
  getPoolMcap,
} from '@/utils/meteora';
import { getAgentConfig, saveCandidates } from '@/utils/dlmm/db';
import { sendDlmmScreenAlert } from '@/utils/telegram';
import { cacheGet, cacheSet } from '@/utils/redis-cache';
import {
  applySolDlmmConfidence,
  solDlmmConfidence,
} from '@/utils/dlmm/sol-dlmm-confidence';

const LAST_GOOD_KEY = 'dlmm:screen:sol:last-good';
const LAST_GOOD_TTL_S = 1800;

type LastGoodSnapshot = {
  raw: DlmmScreenCandidate[];
  screenedAt: string;
};

function scorePool(params: {
  feeTvl: number;
  organicScore: number;
  tvl: number;
  holders: number;
  minTvl: number;
  minFeeTvl: number;
  minOrganic: number;
  minHolders: number;
}): number {
  if (params.tvl < params.minTvl) return 0;
  if (params.feeTvl < params.minFeeTvl) return 0;
  if (params.organicScore < params.minOrganic) return 0;
  if (params.holders < params.minHolders) return 0;

  const feeScore = Math.min(40, params.feeTvl * 200);
  const organicScore = Math.min(30, params.organicScore * 0.3);
  const tvlScore = Math.min(20, Math.log10(Math.max(params.tvl, 1)) * 5);
  const holderScore = Math.min(10, Math.log10(Math.max(params.holders, 1)) * 3);
  return Math.round((feeScore + organicScore + tvlScore + holderScore) * 10) / 10;
}

async function screenFromPools(
  pools: Awaited<ReturnType<typeof fetchMeteoraPools>>,
  screenedAt: string,
): Promise<DlmmScreenCandidate[]> {
  const config = await getAgentConfig();
  return pools
    .map((pool) => {
      const feeTvl = getFeeTvlRatio24h(pool);
      const organicScore = estimateOrganicScore(pool);
      const holders = Math.max(pool.token_x.holders ?? 0, pool.token_y.holders ?? 0);
      const score = scorePool({
        feeTvl,
        organicScore,
        tvl: pool.tvl,
        holders,
        minTvl: config.min_tvl,
        minFeeTvl: config.min_fee_tvl,
        minOrganic: config.min_organic_score,
        minHolders: config.min_holders,
      });
      return {
        pool_address: pool.address,
        pool_name: pool.name,
        token_x_symbol: pool.token_x.symbol,
        token_y_symbol: pool.token_y.symbol,
        tvl: pool.tvl,
        fee_tvl_ratio_24h: feeTvl,
        organic_score: organicScore,
        holders,
        mcap: getPoolMcap(pool),
        score,
        screened_at: screenedAt,
        chain: 'sol',
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
}

export async function runDlmmScreen(options?: { notify?: boolean }) {
  const screenedAt = new Date().toISOString();
  let raw: DlmmScreenCandidate[] | null = null;
  let fetchError = false;

  try {
    const pools = await fetchMeteoraPools({ limit: 100, sortBy: 'fee_tvl_ratio_24h:desc' });
    raw = await screenFromPools(pools, screenedAt);
  } catch (error) {
    fetchError = true;
    console.warn(
      '[dlmm/screen] Meteora fetch failed:',
      error instanceof Error ? error.message : error,
    );
  }

  if (raw && raw.length > 0) {
    await cacheSet(LAST_GOOD_KEY, { raw, screenedAt } satisfies LastGoodSnapshot, LAST_GOOD_TTL_S);
  } else {
    const snap = await cacheGet<LastGoodSnapshot>(LAST_GOOD_KEY);
    raw = snap?.raw ?? [];
    fetchError = true;
  }

  const snapAt = raw[0]?.screened_at ?? screenedAt;
  const confidence = solDlmmConfidence({
    lastOkAtMs: Date.parse(snapAt),
    fetchError,
  });
  const candidates = applySolDlmmConfidence(raw, confidence.score).map((c) => ({
    ...c,
    screened_at: screenedAt,
    chain: 'sol' as const,
    features: { reasons: confidence.reasons, lagS: confidence.lagS, noTrade: confidence.noTrade },
  }));

  await saveCandidates(candidates);

  if (options?.notify !== false && candidates.length > 0 && !fetchError) {
    try {
      await sendDlmmScreenAlert(
        candidates.map((c) => ({
          name: c.pool_name,
          score: c.score,
          feeTvl: c.fee_tvl_ratio_24h,
          tvl: c.tvl,
        })),
      );
    } catch (error) {
      console.warn('[dlmm/screen] telegram notify skipped:', error);
    }
  }

  return {
    success: true,
    candidateCount: candidates.length,
    candidates,
    screenedAt,
    confidence: confidence.score,
    noTrade: confidence.noTrade,
    reasons: confidence.reasons,
    stale: fetchError,
  };
}
