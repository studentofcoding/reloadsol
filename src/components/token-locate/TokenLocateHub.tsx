"use client";

import RawJsonPanel from "@/components/token-locate/RawJsonPanel";
import { isValidMintAddress } from "@/utils/jupiter";
import type { RawSection, StrategyPresence, TokenLocateResult } from "@/strategies/token-locate";
import { useCallback, useEffect, useMemo, useState } from "react";

function truncateMint(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function formatUsd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function labelBadgeClass(label: string): string {
  switch (label) {
    case "rugged":
      return "bg-red-900/60 text-red-300";
    case "potential":
      return "bg-amber-900/60 text-amber-300";
    case "valid":
    case "traded_live":
      return "bg-green-900/60 text-green-300";
    case "watching":
      return "bg-blue-900/60 text-blue-300";
    default:
      return "bg-gray-800 text-gray-300";
  }
}

type LocateResponse = TokenLocateResult & { success: boolean; error?: string; cached?: boolean };

type TokenLocateHubProps = {
  initialAddress?: string;
};

export default function TokenLocateHub({ initialAddress = "" }: TokenLocateHubProps) {
  const [address, setAddress] = useState(initialAddress);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LocateResponse | null>(null);

  const runSearch = useCallback(async (mint: string, refresh = false) => {
    const trimmed = mint.trim();
    if (!isValidMintAddress(trimmed)) {
      setError("Enter a valid Solana mint address");
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ address: trimmed });
      if (refresh) params.set("refresh", "true");
      const res = await fetch(`/api/strategies/token-locate?${params.toString()}`);
      const json = (await res.json()) as LocateResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Lookup failed");
      }
      setResult(json);
      const url = new URL(window.location.href);
      url.searchParams.set("address", trimmed);
      window.history.replaceState(null, "", url.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialAddress && isValidMintAddress(initialAddress.trim())) {
      void runSearch(initialAddress);
    }
  }, [initialAddress, runSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch(address);
  };

  const rawJupiterSections = useMemo(
    () => result?.rawSections.filter((s) => s.dataTier === "raw") ?? [],
    [result],
  );
  const enrichedJupiterSections = useMemo(
    () => result?.rawSections.filter((s) => s.dataTier === "jupiter_enriched") ?? [],
    [result],
  );
  const internalSections = useMemo(
    () => result?.rawSections.filter((s) => s.dataTier === "internal") ?? [],
    [result],
  );

  const enrichment = result?.jupiterEnrichment;
  const liveMcap =
    enrichment?.mcap ?? enrichment?.fdv ?? result?.locations.mcap?.currentMcap;
  const spotPrice = enrichment?.priceUsd;
  const organic = enrichment?.organicScore;

  const presenceRows = result?.strategyPresence ?? [];

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Paste token mint address…"
          className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-sm text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
        {result ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void runSearch(address, true)}
            className="rounded-lg border border-gray-600 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Refresh
          </button>
        ) : null}
      </form>

      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-red-300">
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-semibold text-white">
                {result.symbol ?? "Unknown token"}
              </h2>
              {result.cached ? (
                <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                  cached
                </span>
              ) : null}
              {result.liveOnly ? (
                <span className="rounded bg-purple-900/50 px-2 py-0.5 text-xs text-purple-300">
                  Jupiter only
                </span>
              ) : null}
              {result.found ? (
                <span className="rounded bg-green-900/50 px-2 py-0.5 text-xs text-green-300">
                  Found in DB
                </span>
              ) : (
                <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                  Not in internal DB
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-sm text-gray-400">
              <span>{truncateMint(result.tokenAddress)}</span>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(result.tokenAddress)}
                className="rounded border border-gray-600 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-800"
              >
                Copy
              </button>
              <a
                href={result.links.chart}
                className="text-blue-400 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Chart
              </a>
              <a
                href={result.links.jupiter}
                className="text-blue-400 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Jupiter
              </a>
            </div>
          </div>

          {(liveMcap != null ||
            organic != null ||
            spotPrice != null ||
            result.locations.trending ||
            result.locations.mcap?.firstMcap != null) && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {enrichment?.mcap != null ? (
                <Stat label="Mcap (Jupiter raw)" value={formatUsd(enrichment.mcap)} />
              ) : result.locations.mcap?.currentMcap != null ? (
                <Stat label="Mcap (DB)" value={formatUsd(result.locations.mcap.currentMcap)} />
              ) : liveMcap != null ? (
                <Stat label="Mcap" value={formatUsd(liveMcap)} />
              ) : null}
              {enrichment?.fdv != null ? (
                <Stat label="FDV (Jupiter raw)" value={formatUsd(enrichment.fdv)} />
              ) : null}
              {spotPrice != null ? (
                <Stat label="Price (Jupiter raw)" value={`$${spotPrice.toPrecision(4)}`} />
              ) : null}
              {organic != null ? (
                <Stat label="Organic score (Jupiter)" value={String(organic)} />
              ) : null}
              {result.locations.mcap?.firstMcap != null ? (
                <Stat label="First mcap (DB)" value={formatUsd(result.locations.mcap.firstMcap)} />
              ) : null}
              {result.locations.trending?.peakGainPct != null ? (
                <Stat
                  label="Peak gain"
                  value={`${result.locations.trending.peakGainPct.toFixed(1)}%`}
                />
              ) : null}
            </div>
          )}

          {presenceRows.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
                Strategy presence
              </h3>
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-gray-900/80 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2">Domain</th>
                      <th className="px-4 py-2">Strategy</th>
                      <th className="px-4 py-2">Status / Label</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {presenceRows.map((row, i) => (
                      <PresenceRow key={`${row.source}-${row.domain}-${row.strategyId ?? i}`} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {rawJupiterSections.length > 0 ? (
            <SectionGroup title="Raw Jupiter API responses" sections={rawJupiterSections} />
          ) : null}

          {enrichedJupiterSections.length > 0 ? (
            <SectionGroup
              title="Jupiter enrichment / derived stats"
              sections={enrichedJupiterSections}
            />
          ) : null}

          {internalSections.length > 0 ? (
            <SectionGroup title="Internal raw DB + social" sections={internalSections} />
          ) : null}

          {!result.found &&
          rawJupiterSections.length === 0 &&
          enrichedJupiterSections.length === 0 ? (
            <p className="text-gray-400">No data found for this mint.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PresenceRow({ row }: { row: StrategyPresence }) {
  const statusLabel = row.label ?? row.status;
  return (
    <tr className="bg-gray-900/30 hover:bg-gray-900/50">
      <td className="px-4 py-2 font-mono text-xs text-gray-300">{row.domain}</td>
      <td className="px-4 py-2 text-white">
        {row.strategyName ?? row.strategyId ?? "—"}
      </td>
      <td className="px-4 py-2">
        {statusLabel ? (
          <span className={`rounded px-1.5 py-0.5 text-xs uppercase ${labelBadgeClass(statusLabel)}`}>
            {statusLabel}
          </span>
        ) : row.recordCount != null ? (
          <span className="text-gray-400">{row.recordCount} record(s)</span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-gray-500">{row.source}</td>
      <td className="px-4 py-2">
        {row.deepLink ? (
          <a href={row.deepLink} className="text-blue-400 hover:underline">
            Open
          </a>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

function SectionGroup({ title, sections }: { title: string; sections: RawSection[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-3 flex w-full items-center gap-2 text-left text-sm font-medium uppercase tracking-wide text-gray-500 hover:text-gray-400"
      >
        <span>{open ? "▼" : "▶"}</span>
        {title}
        <span className="text-xs normal-case text-gray-600">({sections.length})</span>
      </button>
      {open ? (
        <div className="space-y-3">
          {sections.map((s) => (
            <RawJsonPanel
              key={s.id}
              label={s.label}
              source={s.source}
              recordLabel={s.recordLabel}
              dataTier={s.dataTier}
              data={s.data}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="font-medium text-white">{value}</p>
    </div>
  );
}
