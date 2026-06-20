'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import GmgnKlineChart from '@/components/GmgnKlineChart';
import { useDlmmPotentialList } from '@/hooks/useDlmmPotentialList';
import type { DlmmScreenCandidate } from '@/types/dlmm';
import type { EnrichedPool } from '@/hooks/useDlmmPools';
import { getPoolChartMint } from '@/utils/gmgn';

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export type DisplayCandidate = DlmmScreenCandidate & {
  token_x_address?: string;
  token_y_address?: string;
  potentialId?: string;
  source?: string;
  list_token_address?: string;
};

type HunterCandidateTabsProps = {
  generalCandidates: DisplayCandidate[];
  pools: EnrichedPool[];
  poolsLoading: boolean;
  poolsError: boolean;
  poolsErrorMsg: unknown;
  dbReady: boolean;
  onDeploy: (pool: EnrichedPool) => void;
};

function findPoolForToken(pools: EnrichedPool[], tokenAddress: string) {
  return pools.find(
    (p) =>
      p.token_x.address === tokenAddress ||
      p.token_y.address === tokenAddress,
  );
}

function CandidateCard({
  c,
  pools,
  dbReady,
  onDeploy,
  onRemove,
  showSource,
}: {
  c: DisplayCandidate;
  pools: EnrichedPool[];
  dbReady: boolean;
  onDeploy: (pool: EnrichedPool) => void;
  onRemove?: () => void;
  showSource?: boolean;
}) {
  const chartMint = getPoolChartMint(c.token_x_address, c.token_y_address);
  const chartSymbol =
    chartMint === c.token_y_address ? c.token_y_symbol : c.token_x_symbol;
  const matchedPool = pools.find((p) => p.address === c.pool_address);

  return (
    <div className="bg-gray-800 border border-gray-600 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-white font-bold">{c.pool_name}</h3>
          {showSource && c.source && (
            <p className="text-xs text-purple-300 mt-0.5">via {c.source}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {c.score > 0 && (
            <span className="text-xs text-gray-500">
              Score {c.score.toFixed(1)}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {chartMint ? (
        <GmgnKlineChart
          tokenMint={chartMint}
          symbol={chartSymbol}
          height={300}
          interval="5m"
        />
      ) : (
        <div className="h-[300px] rounded-lg border border-gray-700 bg-gray-900 flex items-center justify-center text-gray-500 text-sm">
          Chart unavailable (missing token mint)
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm text-gray-400">
        <div>
          <div className="text-gray-500 text-xs">TVL</div>
          {formatUsd(c.tvl)}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Fee/TVL 24h</div>
          {(c.fee_tvl_ratio_24h * 100).toFixed(2)}%
        </div>
        <div>
          <div className="text-gray-500 text-xs">Organic</div>
          {c.organic_score.toFixed(1)}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Holders</div>
          {c.holders.toLocaleString()}
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          if (matchedPool) {
            onDeploy(matchedPool);
            return;
          }
          onDeploy({
            address: c.pool_address,
            name: c.pool_name,
            token_x: {
              address: c.token_x_address ?? '',
              name: '',
              symbol: c.token_x_symbol,
              decimals: 9,
            },
            token_y: {
              address: c.token_y_address ?? '',
              name: '',
              symbol: c.token_y_symbol,
              decimals: 9,
            },
            tvl: c.tvl,
            current_price: 0,
            pool_config: {
              bin_step: 0,
              base_fee_pct: 0,
              max_fee_pct: 0,
              protocol_fee_pct: 0,
              collect_fee_mode: 0,
            },
            organic_score: c.organic_score,
            fee_tvl_ratio_24h: c.fee_tvl_ratio_24h,
          } as EnrichedPool);
        }}
        disabled={!dbReady || !matchedPool}
        className="mt-1 w-full py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded"
        title={matchedPool ? 'Deploy LP position' : 'No Meteora pool found for this token yet'}
      >
        {matchedPool ? 'Deploy' : 'No pool — watch only'}
      </button>
    </div>
  );
}

export default function HunterCandidateTabs({
  generalCandidates,
  pools,
  poolsLoading,
  poolsError,
  poolsErrorMsg,
  dbReady,
  onDeploy,
}: HunterCandidateTabsProps) {
  const [tab, setTab] = useState<'general' | 'potential'>('general');
  const { entries, remove, isLoading: potentialLoading } = useDlmmPotentialList();

  const potentialCandidates: DisplayCandidate[] = useMemo(() => {
    return entries.map((entry) => {
      const pool = findPoolForToken(pools, entry.token_address);
      if (pool) {
        return {
          pool_address: pool.address,
          pool_name: pool.name,
          token_x_symbol: pool.token_x.symbol,
          token_y_symbol: pool.token_y.symbol,
          token_x_address: pool.token_x.address,
          token_y_address: pool.token_y.address,
          tvl: pool.tvl,
          fee_tvl_ratio_24h: pool.fee_tvl_ratio_24h,
          organic_score: pool.organic_score,
          holders: Math.max(
            pool.token_x.holders ?? 0,
            pool.token_y.holders ?? 0,
          ),
          mcap: 0,
          score: pool.organic_score,
          screened_at: entry.added_at,
          potentialId: entry.id,
          source: entry.source,
          list_token_address: entry.token_address,
        };
      }

      return {
        pool_address: entry.token_address,
        pool_name: entry.token_symbol || entry.token_address.slice(0, 8) + '…',
        token_x_symbol: entry.token_symbol || '?',
        token_y_symbol: 'SOL',
        token_x_address: entry.token_address,
        token_y_address: undefined,
        tvl: 0,
        fee_tvl_ratio_24h: 0,
        organic_score: 0,
        holders: 0,
        mcap: 0,
        score: 0,
        screened_at: entry.added_at,
        potentialId: entry.id,
        source: entry.source,
        list_token_address: entry.token_address,
      };
    });
  }, [entries, pools]);

  const activeList =
    tab === 'general' ? generalCandidates : potentialCandidates;

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-xl font-bold text-white">Hunter Candidates</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('general')}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              tab === 'general'
                ? 'bg-white text-black'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            General ({generalCandidates.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('potential')}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              tab === 'potential'
                ? 'bg-purple-500 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            Potential ({potentialCandidates.length})
          </button>
        </div>
      </div>

      {tab === 'general' ? (
        <p className="text-gray-500 text-sm mb-4">
          Automated Hunter screen — pools matching agent thresholds.
        </p>
      ) : (
        <p className="text-gray-500 text-sm mb-4">
          Curated from Signals, Board, Tracker, or Algo Tester via{' '}
          <span className="text-purple-300">DLMM+</span>. Add or remove on any
          token row, then deploy when a Meteora pool is found.
        </p>
      )}

      {poolsLoading || (tab === 'potential' && potentialLoading) ? (
        <p className="text-gray-400">Loading pools from Meteora...</p>
      ) : poolsError ? (
        <p className="text-red-400 text-sm">
          {poolsErrorMsg instanceof Error
            ? poolsErrorMsg.message
            : 'Failed to load pools'}
        </p>
      ) : activeList.length === 0 ? (
        <div className="text-gray-500 text-sm">
          {tab === 'general' ? (
            'No pools matched screening thresholds.'
          ) : (
            <>
              No tokens on the Potential list yet. Use{' '}
              <span className="text-purple-300">DLMM+</span> on{' '}
              <Link href="/dev/signals" className="text-blue-400 underline">
                Signals
              </Link>{' '}
              or{' '}
              <Link href="/dev/algo-tester" className="text-blue-400 underline">
                Algo Tester
              </Link>
              .
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {activeList.map((c) => (
            <CandidateCard
              key={c.potentialId ?? c.pool_address}
              c={c}
              pools={pools}
              dbReady={dbReady}
              onDeploy={onDeploy}
              showSource={tab === 'potential'}
              onRemove={
                tab === 'potential' && c.list_token_address
                  ? () => void remove(c.list_token_address!)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
