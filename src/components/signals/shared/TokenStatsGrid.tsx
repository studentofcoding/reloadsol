"use client";

/** Shared compact token-stat grid (DLMM-card parity) used on the RH LP cards
 *  and the buy-page TrendingTokens column. All cells are optional — any field
 *  that isn't present renders an em-dash, so it works across data sources
 *  (GMGN rank vs Jupiter filtered). */

export function formatStatUsd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatStatPct(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export function formatStatCount(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString();
}

export type TokenStats = {
  mcap?: number | null;
  volume24h?: number | null;
  liquidity?: number | null;
  holders?: number | null;
  priceChangePct?: number | null;
  launchpad?: string | null;
  smartDegenCount?: number | null;
  renownedCount?: number | null;
  hotLevel?: number | null;
  visitingCount?: number | null;
  communityCue?: string | null;
  fomoCue?: string | null;
};

export function communityCueLabel(cue?: string | null): string | null {
  if (cue === "komun_ok") return "komun jelas";
  if (cue === "komun_thin") return "komun tipis";
  return null;
}

export function fomoCueLabel(cue?: string | null): string | null {
  if (cue === "fomo_hot") return "fomo hot";
  if (cue === "fomo_quiet") return "fomo quiet";
  return null;
}

function StatCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "pos" | "neg";
}) {
  return (
    <div>
      <div className="text-gray-500 text-xs">{label}</div>
      <div
        className={
          tone === "pos"
            ? "text-green-400"
            : tone === "neg"
              ? "text-red-400"
              : "text-white"
        }
      >
        {value}
      </div>
    </div>
  );
}

export function TokenStatsGrid({ stats }: { stats: TokenStats }) {
  const change =
    stats.priceChangePct != null && Number.isFinite(stats.priceChangePct)
      ? stats.priceChangePct
      : null;
  const changeTone =
    change == null ? "default" : change >= 0 ? "pos" : "neg";
  const komun = communityCueLabel(stats.communityCue);
  const fomo = fomoCueLabel(stats.fomoCue);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm text-gray-400">
      <StatCell label="Mcap" value={formatStatUsd(stats.mcap)} />
      <StatCell
        label="Vol 24h"
        value={formatStatUsd(stats.volume24h)}
      />
      <StatCell
        label="Liquidity"
        value={formatStatUsd(stats.liquidity)}
      />
      <StatCell
        label="Holders"
        value={formatStatCount(stats.holders)}
      />
      <StatCell label="24h" value={formatStatPct(change)} tone={changeTone} />
      <StatCell label="Launchpad" value={stats.launchpad || "—"} />
      <StatCell
        label="SM / KOL"
        value={`${formatStatCount(stats.smartDegenCount)} / ${formatStatCount(stats.renownedCount)}`}
      />
      <StatCell
        label="Hot / visits"
        value={`${formatStatCount(stats.hotLevel)} / ${formatStatCount(stats.visitingCount)}`}
      />
      {(komun || fomo) && (
        <div className="col-span-2 sm:col-span-4 flex flex-wrap gap-2 text-xs">
          {komun && (
            <span
              className={`px-2 py-0.5 rounded ${
                komun === "komun jelas"
                  ? "bg-green-900/50 text-green-300"
                  : "bg-yellow-900/40 text-yellow-300"
              }`}
            >
              {komun}
            </span>
          )}
          {fomo && (
            <span
              className={`px-2 py-0.5 rounded ${
                fomo === "fomo hot"
                  ? "bg-orange-900/50 text-orange-300"
                  : "bg-gray-700 text-gray-300"
              }`}
            >
              {fomo}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
