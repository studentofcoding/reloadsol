import { NextRequest, NextResponse, connection } from 'next/server';
import { fetchMeteoraPools, estimateOrganicScore, getFeeTvlRatio24h } from '@/utils/meteora';
import { getLatestCandidates } from '@/utils/dlmm/db';

export async function GET(req: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(req.url);
    const source = searchParams.get('source') ?? 'live';
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);

    if (source === 'candidates') {
      const candidates = await getLatestCandidates(limit);
      return NextResponse.json({ success: true, candidates });
    }

    const pools = await fetchMeteoraPools({ limit });
    const enriched = pools.map((pool) => ({
      ...pool,
      organic_score: estimateOrganicScore(pool),
      fee_tvl_ratio_24h: getFeeTvlRatio24h(pool),
    }));

    return NextResponse.json({
      success: true,
      pools: enriched,
      count: enriched.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch pools',
      },
      { status: 500 },
    );
  }
}
