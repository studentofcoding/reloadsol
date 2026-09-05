"use client";

import ChartBuyModal from "@/components/ChartBuyModal";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import React, { useMemo, useState } from "react";

export type FomoFillRow = {
  source_fill_id: number | string;
  occurred_at: string;
  side: string;
  handle: string | null;
  wallet_address: string;
  token_address: string;
  symbol: string | null;
  usd: number | null;
  priced: string | null;
  is_stock: boolean;
  tx: string;
};

export type FomoHealth = {
  success: boolean;
  last_fill_id: number;
  lag_seconds: number | null;
  last_block: number | null;
  last_hello_at: string | null;
  last_ingest_at: string | null;
  viewers: number | null;
  fills_per_min: number;
  fills: FomoFillRow[];
  error?: string;
};

async function fetchFomoHealth(): Promise<FomoHealth> {
  const res = await fetch("/api/fomo/ingest?limit=60", { cache: "no-store" });
  const json = (await res.json()) as FomoHealth;
  if (!res.ok || !json.success) {
    throw new Error(json.error || "FOMO ingest health failed");
  }
  return json;
}

function truncateAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsd(usd: number | null, priced: string | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const body = usd >= 100 ? usd.toFixed(0) : usd.toFixed(2);
  return priced === "estimate" ? `~$${body}` : `$${body}`;
}

export default function FomoMirrorPanel({
  showPageLink = true,
}: {
  showPageLink?: boolean;
}) {
  const q = useQuery({
    queryKey: ["fomo-ingest-health"],
    queryFn: fetchFomoHealth,
    refetchInterval: 10_000,
  });

  const data = q.data;
  const fills = useMemo(() => data?.fills ?? [], [data?.fills]);
  const tokenList = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of fills) {
      const a = f.token_address?.trim();
      if (!a) continue;
      const key = a.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }, [fills]);
  const [modalTokenAddress, setModalTokenAddress] = useState<string | null>(
    null,
  );
  const modalIndex = modalTokenAddress
    ? tokenList.findIndex(
        (a) => a.toLowerCase() === modalTokenAddress.toLowerCase(),
      )
    : -1;
  const ingestAgeMs = data?.last_ingest_at
    ? Date.now() - new Date(data.last_ingest_at).getTime()
    : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium text-white">
          FOMO / robinhoodtrenches
        </h2>
        {showPageLink ? (
          <Link
            href="/dev/fomo"
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Open live page
          </Link>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">
        Research-grade mirror of fomo.family fills on Robinhood (chain 4663). Not
        an execution feed.
      </p>
      {q.error ? (
        <p className="text-sm text-red-400">
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
          <div className="text-gray-400">Mirror</div>
          <div className={ingestAgeMs != null && ingestAgeMs < 90_000 ? "text-green-400" : "text-yellow-400"}>
            {q.isLoading
              ? "…"
              : ingestAgeMs == null
                ? "no ingest yet"
                : ingestAgeMs < 90_000
                  ? "receiving"
                  : "stale"}
          </div>
        </div>
        <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
          <div className="text-gray-400">last_id</div>
          <div className="font-mono text-white">{data?.last_fill_id ?? "—"}</div>
        </div>
        <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
          <div className="text-gray-400">lag / fills/min</div>
          <div className="text-white">
            {data?.lag_seconds ?? "—"}s · {data?.fills_per_min ?? "—"}
          </div>
        </div>
        <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
          <div className="text-gray-400">last ingest</div>
          <div className="text-xs text-gray-300">
            {data?.last_ingest_at ?? "—"}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded border border-gray-800">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-900 text-gray-400">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Handle</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">USD</th>
              <th className="px-3 py-2">Token</th>
              <th className="px-3 py-2">Wallet</th>
              <th className="px-3 py-2">priced</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr
                key={String(f.source_fill_id)}
                className="border-t border-gray-800 text-gray-200"
              >
                <td className="px-3 py-2 text-xs text-gray-400">
                  {f.occurred_at}
                </td>
                <td className="px-3 py-2">{f.handle ?? "—"}</td>
                <td
                  className={`px-3 py-2 ${
                    f.side === "buy" ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {f.side}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {formatUsd(f.usd, f.priced)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <button
                    type="button"
                    className="text-left text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline"
                    onClick={() => setModalTokenAddress(f.token_address)}
                  >
                    {f.symbol ?? truncateAddr(f.token_address)}
                  </button>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {truncateAddr(f.wallet_address)}
                </td>
                <td className="px-3 py-2 text-xs text-gray-400">
                  {f.priced ?? "—"}
                </td>
              </tr>
            ))}
            {fills.length === 0 && !q.isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-gray-500">
                  No fills yet — apply db/init/28-fomo-fills.sql, set
                  FOMO_WS_ENABLED, restart cron.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {modalTokenAddress ? (
        <ChartBuyModal
          tokenAddress={modalTokenAddress}
          onClose={() => setModalTokenAddress(null)}
          onNavigate={(direction) => {
            if (modalIndex === -1 || tokenList.length === 0) return;
            const nextIndex =
              direction === "next" ? modalIndex + 1 : modalIndex - 1;
            if (nextIndex >= 0 && nextIndex < tokenList.length) {
              setModalTokenAddress(tokenList[nextIndex]);
            }
          }}
          hasPrev={modalIndex > 0}
          hasNext={modalIndex >= 0 && modalIndex < tokenList.length - 1}
        />
      ) : null}
    </section>
  );
}
