'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import GmgnKlineChart from '@/components/GmgnKlineChart';
import DlmmChartActions from '@/components/dlmm/DlmmChartActions';
import { usePotentialList } from '@/hooks/usePotentialList';
import { useRobinhoodScreen } from '@/hooks/useRobinhoodScreen';
import { useRugList } from '@/hooks/useRugList';
import type { DlmmPotentialSource, DlmmScreenCandidate } from '@/types/dlmm';
import type { EnrichedPool } from '@/hooks/useDlmmPools';
import { getGmgnTokenUrl, getPoolChartMint } from '@/utils/gmgn';
import type { RobinhoodScreenToken } from '@/utils/dlmm/robinhood-screen';
import { ROBINHOOD_LP_DEFAULTS } from '@/utils/dlmm/robinhood-screen';
import {
  copyTokenAddress,
  getLpTerminalPoolsUrl,
} from '@/utils/dlmm/lp-terminal';
import DlmmGeneralPoolsTable from '@/components/dlmm/DlmmGeneralPoolsTable';
import LpTerminalPoolsTable from '@/components/dlmm/LpTerminalPoolsTable';
import RhUniv2LpSheet from '@/components/dlmm/RhUniv2LpSheet';
import ScrollableMenuRow from '@/components/ScrollableMenuRow';

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatPct(n: number) {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function socialHref(raw: string, kind: 'twitter' | 'telegram' | 'website'): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  if (kind === 'twitter') {
    const handle = v.replace(/^@/, '');
    return `https://x.com/${handle}`;
  }
  if (kind === 'telegram') {
    const handle = v.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
    return `https://t.me/${handle}`;
  }
  return `https://${v}`;
}

export type DisplayCandidate = DlmmScreenCandidate & {
  token_x_address?: string;
  token_y_address?: string;
  potentialId?: string;
  source?: string;
  list_token_address?: string;
};

type HunterCandidateTabsProps = {
  network: 'sol' | 'robinhood';
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

export function chartTokenAddress(c: DisplayCandidate): string {
  return c.list_token_address ?? c.token_x_address ?? c.pool_address;
}

function CandidateCard({
  c,
  pools,
  dbReady,
  onDeploy,
  onRemove,
  showSource,
  actionSource,
}: {
  c: DisplayCandidate;
  pools: EnrichedPool[];
  dbReady: boolean;
  onDeploy: (pool: EnrichedPool) => void;
  onRemove?: () => void;
  showSource?: boolean;
  actionSource: DlmmPotentialSource;
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

      <DlmmChartActions
        tokenAddress={chartTokenAddress(c)}
        tokenSymbol={c.token_x_symbol}
        source={actionSource}
      />

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

function RobinhoodCard({ t }: { t: RobinhoodScreenToken }) {
  const twitter = socialHref(t.twitter, 'twitter');
  const telegram = socialHref(t.telegram, 'telegram');
  const website = socialHref(t.website, 'website');
  const lpTerminalUrl = getLpTerminalPoolsUrl(t.address);
  const [copied, setCopied] = useState(false);
  const [lpOpen, setLpOpen] = useState(false);

  return (
    <div className="bg-gray-800 border border-gray-600 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-white font-bold">
            {t.symbol}{' '}
            <span className="text-gray-400 font-normal text-sm">{t.name}</span>
          </h3>
          <p className="text-xs text-gray-500 mt-0.5 font-mono break-all">
            {t.address}
          </p>
        </div>
        <a
          href={getGmgnTokenUrl(t.address, 'robinhood')}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs text-blue-400 hover:text-blue-300"
        >
          GMGN ↗
        </a>
      </div>

      <GmgnKlineChart
        tokenMint={t.address}
        symbol={t.symbol}
        chain="robinhood"
        height={260}
        interval="5"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm text-gray-400">
        <div>
          <div className="text-gray-500 text-xs">Mcap</div>
          {formatUsd(t.marketCap)}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Vol 24h</div>
          {formatUsd(t.volume24h)}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Liquidity</div>
          {formatUsd(t.liquidity)}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Holders</div>
          {t.holders.toLocaleString()}
        </div>
        <div>
          <div className="text-gray-500 text-xs">24h</div>
          <span
            className={
              t.priceChangePct >= 0 ? 'text-green-400' : 'text-red-400'
            }
          >
            {formatPct(t.priceChangePct)}
          </span>
        </div>
        <div>
          <div className="text-gray-500 text-xs">Launchpad</div>
          {t.launchpad}
        </div>
        <div>
          <div className="text-gray-500 text-xs">SM / KOL</div>
          {t.smartDegenCount} / {t.renownedCount}
        </div>
        <div>
          <div className="text-gray-500 text-xs">Hot / visits</div>
          {t.hotLevel} / {t.visitingCount}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span
          className={`px-2 py-0.5 rounded ${
            t.communityCue === 'komun_ok'
              ? 'bg-green-900/50 text-green-300'
              : 'bg-yellow-900/40 text-yellow-300'
          }`}
        >
          {t.communityCue === 'komun_ok' ? 'komun jelas' : 'komun tipis'}
        </span>
        <span
          className={`px-2 py-0.5 rounded ${
            t.fomoCue === 'fomo_hot'
              ? 'bg-orange-900/50 text-orange-300'
              : 'bg-gray-700 text-gray-300'
          }`}
        >
          {t.fomoCue === 'fomo_hot' ? 'fomo hot' : 'fomo quiet'}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        {twitter && (
          <a
            href={twitter}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            Twitter
          </a>
        )}
        {telegram && (
          <a
            href={telegram}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            Telegram
          </a>
        )}
        {website && (
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            Website
          </a>
        )}
        {!twitter && !telegram && !website && (
          <span className="text-gray-500">No socials</span>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-1">
        <button
          type="button"
          onClick={() => setLpOpen(true)}
          className="flex-1 text-center py-2 bg-emerald-600 hover:bg-emerald-500 text-black text-sm font-medium rounded"
        >
          Add LP
        </button>
        <a
          href={lpTerminalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-2 text-center text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded"
        >
          LP Terminal ↗
        </a>
        <button
          type="button"
          onClick={() => {
            void copyTokenAddress(t.address).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded"
          title="Copy token address"
        >
          {copied ? 'Copied CA' : 'Copy CA'}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        In-app Uniswap V2 zap (USDG/WETH) on Robinhood — not Meteora Deploy.
      </p>
      {lpOpen ? (
        <RhUniv2LpSheet
          open
          onClose={() => setLpOpen(false)}
          tokenAddress={t.address}
          tokenSymbol={t.symbol}
        />
      ) : null}
    </div>
  );
}

export default function HunterCandidateTabs({
  network,
  generalCandidates,
  pools,
  poolsLoading,
  poolsError,
  poolsErrorMsg,
  dbReady,
  onDeploy,
}: HunterCandidateTabsProps) {
  type HunterTab = 'general' | 'potential' | 'robinhood';
  const defaultTab: HunterTab =
    network === 'robinhood' ? 'robinhood' : 'general';
  const [tabOverride, setTabOverride] = useState<HunterTab | null>(null);
  const [prevNetwork, setPrevNetwork] = useState(network);
  if (prevNetwork !== network) {
    setPrevNetwork(network);
    setTabOverride(null);
  }
  const tab = tabOverride ?? defaultTab;
  const setTab = (next: HunterTab) => setTabOverride(next);
  const [robinhoodView, setRobinhoodView] = useState<'pools' | 'gmgn'>('pools');

  const { entries, remove, isLoading: potentialLoading } = usePotentialList();
  const {
    tokens: robinhoodTokens,
    fetchedAt: robinhoodFetchedAt,
    isLoading: robinhoodLoading,
    isFetching: robinhoodFetching,
    error: robinhoodError,
    refetch: refetchRobinhood,
  } = useRobinhoodScreen(
    network === 'robinhood' && tab === 'robinhood' && robinhoodView === 'gmgn',
  );
  const { addressSet: rugAddressSet, isLoading: rugLoading } = useRugList();

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

  const visibleGeneral = useMemo(
    () =>
      generalCandidates.filter(
        (c) => !rugAddressSet.has(chartTokenAddress(c)),
      ),
    [generalCandidates, rugAddressSet],
  );

  const visiblePotential = useMemo(
    () =>
      potentialCandidates.filter(
        (c) => !rugAddressSet.has(chartTokenAddress(c)),
      ),
    [potentialCandidates, rugAddressSet],
  );

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-xl font-bold text-white">
          {network === 'robinhood' ? 'Robinhood LP' : 'Hunter Candidates'}
        </h2>
        {network === 'sol' ? (
          <ScrollableMenuRow innerClassName="gap-2" bleed={false}>
            <button
              type="button"
              onClick={() => setTab('general')}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium ${
                tab === 'general'
                  ? 'bg-white text-black'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              General ({visibleGeneral.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('potential')}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium ${
                tab === 'potential'
                  ? 'bg-purple-500 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              Potential ({visiblePotential.length})
            </button>
          </ScrollableMenuRow>
        ) : null}
      </div>

      {tab === 'general' ? (
        <p className="text-gray-500 text-sm mb-4">
          Automated Hunter screen — pools matching agent thresholds.
        </p>
      ) : tab === 'potential' ? (
        <p className="text-gray-500 text-sm mb-4">
          Curated from Signals, Board, Tracker, or Algo Tester. Use{' '}
          <span className="text-green-300">Potential</span> or{' '}
          <span className="text-red-300">Rug</span> on any chart — rugged
          tokens are excluded from both tabs.
        </p>
      ) : (
        <div className="mb-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRobinhoodView('pools')}
              className={`px-3 py-1.5 text-xs font-medium rounded ${
                robinhoodView === 'pools'
                  ? 'bg-emerald-600 text-black'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              Pools
            </button>
            <button
              type="button"
              onClick={() => setRobinhoodView('gmgn')}
              className={`px-3 py-1.5 text-xs font-medium rounded ${
                robinhoodView === 'gmgn'
                  ? 'bg-emerald-600 text-black'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              GMGN screen
            </button>
          </div>
          {robinhoodView === 'pools' ? (
            <p className="text-gray-500 text-sm">
              Uni v2/v3 pools on Robinhood Chain (4663).{' '}
              <span className="text-gray-400">Add LP</span> = in-app V2 zap
              (USDG/WETH);{' '}
              <a
                href={getLpTerminalPoolsUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Terminal ↗
              </a>{' '}
              is the escape hatch (not Meteora Deploy).
            </p>
          ) : (
            <>
              <p className="text-gray-500 text-sm">
                GMGN Robinhood 24h screen — mcap &gt;{' '}
                {formatUsd(ROBINHOOD_LP_DEFAULTS.minMcap)}, vol &gt;{' '}
                {formatUsd(ROBINHOOD_LP_DEFAULTS.minVolume)}, exclude flap.fun.
                Prefer util over meme; check komun + FOMO thesis yourself.
              </p>
              <p className="text-xs text-gray-500 border border-gray-700 rounded px-3 py-2 bg-gray-950/50">
                Playbook: max 3 positions · compound · day = bigcap runner full
                range · night close ~10–20% · fee &gt; IL → gas · convict =
                hold / extend left.
              </p>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <button
                  type="button"
                  onClick={() => void refetchRobinhood()}
                  disabled={robinhoodFetching}
                  className="px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
                >
                  {robinhoodFetching ? 'Refreshing…' : 'Refresh'}
                </button>
                {robinhoodFetchedAt && (
                  <span>
                    Updated {new Date(robinhoodFetchedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'robinhood' ? (
        robinhoodView === 'pools' ? (
          <LpTerminalPoolsTable />
        ) : robinhoodLoading ? (
          <p className="text-gray-400">Loading Robinhood screen from GMGN…</p>
        ) : robinhoodError ? (
          <p className="text-red-400 text-sm">
            {robinhoodError instanceof Error
              ? robinhoodError.message
              : 'Failed to load Robinhood screen'}
          </p>
        ) : robinhoodTokens.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No Robinhood tokens matched filters (mcap / vol / non-flap).
          </p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {robinhoodTokens.map((t) => (
              <RobinhoodCard key={t.address} t={t} />
            ))}
          </div>
        )
      ) : tab === 'general' ? (
        poolsLoading || rugLoading ? (
          <p className="text-gray-400">Loading pools from Meteora...</p>
        ) : poolsError ? (
          <p className="text-red-400 text-sm">
            {poolsErrorMsg instanceof Error
              ? poolsErrorMsg.message
              : 'Failed to load pools'}
          </p>
        ) : visibleGeneral.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No pools matched screening thresholds.
          </p>
        ) : (
          <DlmmGeneralPoolsTable
            candidates={visibleGeneral}
            pools={pools}
            dbReady={dbReady}
            onDeploy={onDeploy}
          />
        )
      ) : poolsLoading || potentialLoading || rugLoading ? (
        <p className="text-gray-400">Loading pools from Meteora...</p>
      ) : poolsError ? (
        <p className="text-red-400 text-sm">
          {poolsErrorMsg instanceof Error
            ? poolsErrorMsg.message
            : 'Failed to load pools'}
        </p>
      ) : visiblePotential.length === 0 ? (
        <div className="text-gray-500 text-sm">
          No tokens on the Potential list yet. Use{' '}
          <span className="text-green-300">Potential</span> on{' '}
          <Link href="/dev/signals" className="text-blue-400 underline">
            Signals
          </Link>{' '}
          or{' '}
          <Link href="/dev/algo-tester" className="text-blue-400 underline">
            Algo Tester
          </Link>
          .
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {visiblePotential.map((c) => (
            <CandidateCard
              key={c.potentialId ?? c.pool_address}
              c={c}
              pools={pools}
              dbReady={dbReady}
              onDeploy={onDeploy}
              showSource
              actionSource={
                c.source
                  ? (c.source as DlmmPotentialSource)
                  : 'dlmm-general'
              }
              onRemove={
                c.list_token_address
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
