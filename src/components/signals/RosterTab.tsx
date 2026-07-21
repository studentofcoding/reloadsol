"use client";

import React, { useCallback, useEffect, useState } from "react";

type RosterRow = {
  address: string;
  status: string;
  follow_status: string;
  score: number;
  runner_hits: number;
  notes: string | null;
  promoted_at: string | null;
  updated_at: string;
};

type DigRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  traders_seen: number;
  promoted: number;
  demoted: number;
  runner_tokens: unknown;
  errors: unknown;
};

type SignalRow = {
  id: number;
  token_address: string;
  symbol: string | null;
  makers: string[];
  fired_at: string;
  telegram_sent: boolean;
  sim_opened: boolean;
  skip_reason: string | null;
  market_cap_usd: number | null;
};

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export default function RosterTab() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [needsFollow, setNeedsFollow] = useState<RosterRow[]>([]);
  const [digRuns, setDigRuns] = useState<DigRun[]>([]);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gmgn/roster");
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        roster?: RosterRow[];
        needsFollow?: RosterRow[];
        digRuns?: DigRun[];
        signals?: SignalRow[];
      };
      if (!data.success) throw new Error(data.error || "load failed");
      setRoster(data.roster ?? []);
      setNeedsFollow(data.needsFollow ?? []);
      setDigRuns(data.digRuns ?? []);
      setSignals(data.signals ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (
    address: string,
    body: { follow_status?: string; status?: string },
  ) => {
    setBusy(address);
    try {
      const res = await fetch("/api/gmgn/roster", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, ...body }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!data.success) throw new Error(data.error || "patch failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-gray-400">Loading roster…</div>;
  }

  return (
    <div className="space-y-8 text-sm text-gray-200">
      {error && (
        <div className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-red-300">
          {error}
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Needs follow</h2>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
          >
            Refresh
          </button>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Soft hybrid: follow these wallets on GMGN, then mark Followed so
          concurrence can count them.
        </p>
        {needsFollow.length === 0 ? (
          <p className="text-gray-500">Queue empty.</p>
        ) : (
          <ul className="divide-y divide-gray-800 rounded border border-gray-800">
            {needsFollow.map((row) => (
              <li
                key={row.address}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
              >
                <code className="text-xs text-amber-200">{shortAddr(row.address)}</code>
                <span className="text-xs text-gray-500">
                  score {row.score.toFixed(1)} · hits {row.runner_hits}
                </span>
                <button
                  type="button"
                  className="rounded bg-gray-800 px-2 py-0.5 text-xs"
                  onClick={() => void copy(row.address)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  disabled={busy === row.address}
                  className="rounded bg-emerald-800 px-2 py-0.5 text-xs text-white disabled:opacity-50"
                  onClick={() =>
                    void patch(row.address, { follow_status: "followed" })
                  }
                >
                  Mark followed
                </button>
                <button
                  type="button"
                  disabled={busy === row.address}
                  className="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-200 disabled:opacity-50"
                  onClick={() => void patch(row.address, { status: "banned" })}
                >
                  Ban
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-white">
          Active / followed roster
        </h2>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Wallet</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Follow</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Hits</th>
              </tr>
            </thead>
            <tbody>
              {roster
                .filter((r) => r.status === "active" || r.follow_status === "followed")
                .slice(0, 80)
                .map((row) => (
                  <tr key={row.address} className="border-t border-gray-800">
                    <td className="px-3 py-1.5 font-mono text-amber-100">
                      {shortAddr(row.address)}
                    </td>
                    <td className="px-3 py-1.5">{row.status}</td>
                    <td className="px-3 py-1.5">{row.follow_status}</td>
                    <td className="px-3 py-1.5">{row.score.toFixed(1)}</td>
                    <td className="px-3 py-1.5">{row.runner_hits}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-white">
          Recent dig runs
        </h2>
        {digRuns.length === 0 ? (
          <p className="text-gray-500">No digs yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-gray-400">
            {digRuns.map((run) => (
              <li key={run.id}>
                #{run.id} · {new Date(run.started_at).toLocaleString()} · traders{" "}
                {run.traders_seen} · promoted {run.promoted} · demoted {run.demoted}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-white">
          Concurrence signals
        </h2>
        {signals.length === 0 ? (
          <p className="text-gray-500">No signals yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800 rounded border border-gray-800">
            {signals.map((s) => (
              <li key={s.id} className="px-3 py-2 text-xs">
                <div className="font-medium text-white">
                  {s.symbol || shortAddr(s.token_address)} ·{" "}
                  {s.makers?.length ?? 0} wallets
                </div>
                <div className="text-gray-500">
                  {new Date(s.fired_at).toLocaleString()}
                  {s.market_cap_usd != null
                    ? ` · mcap $${Math.round(s.market_cap_usd).toLocaleString()}`
                    : ""}
                  {s.telegram_sent ? " · tg" : ""}
                  {s.sim_opened ? " · sim" : ""}
                  {s.skip_reason ? ` · skip: ${s.skip_reason}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
