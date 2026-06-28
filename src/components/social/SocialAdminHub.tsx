"use client";

import React, { useCallback, useEffect, useState } from "react";

type TrackedWallet = {
  address: string;
  label: string;
  tier: "tier1" | "tier2";
  tags: string[];
  is_active: boolean;
  last_polled_at: string | null;
  last_poll_error: string | null;
};

type SocialRollup = {
  token_address: string;
  mention_count_30m: number;
  unique_channel_count_30m: number;
  smart_wallet_buy_count_1h: number;
  top_source: string | null;
  last_event_at: string | null;
  updated_at: string;
};

type SocialStats = {
  eventCount24h: number;
  rollupCount: number;
  walletCount: number;
};

type SocialEvent = {
  id: string;
  token_address: string;
  event_type: string;
  source: string;
  channel_label: string | null;
  wallet_label: string | null;
  occurred_at: string;
};

export default function SocialAdminHub() {
  const [wallets, setWallets] = useState<TrackedWallet[]>([]);
  const [rollups, setRollups] = useState<SocialRollup[]>([]);
  const [events, setEvents] = useState<SocialEvent[]>([]);
  const [stats, setStats] = useState<SocialStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [walletsRes, eventsRes] = await Promise.all([
        fetch("/api/social/wallets?rollups_limit=40"),
        fetch("/api/social/events?limit=50&hours=24&telegram_only=true"),
      ]);
      const json = await walletsRes.json();
      if (!json.success) throw new Error(json.error || "Failed to load");
      setWallets(json.wallets ?? []);
      setRollups(json.rollups ?? []);
      setStats(json.stats ?? null);

      const eventsJson = await eventsRes.json();
      if (eventsJson.success) {
        setEvents(eventsJson.events ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addWallet = async () => {
    if (!newAddress.trim() || !newLabel.trim()) return;
    const res = await fetch("/api/social/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: newAddress.trim(),
        label: newLabel.trim(),
        tier: "tier2",
        tags: [],
        is_active: true,
      }),
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.error || "Add failed");
      return;
    }
    setNewAddress("");
    setNewLabel("");
    await load();
  };

  const removeWallet = async (address: string) => {
    const res = await fetch(
      `/api/social/wallets?address=${encodeURIComponent(address)}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!json.success) {
      setError("Delete failed");
      return;
    }
    await load();
  };

  if (loading) {
    return <p className="text-sm text-gray-400">Loading social data…</p>;
  }

  return (
    <div className="space-y-8">
      {error ? (
        <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {stats ? (
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Events (24h)</div>
            <div className="text-xl font-semibold text-white">{stats.eventCount24h}</div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Rollups</div>
            <div className="text-xl font-semibold text-white">{stats.rollupCount}</div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Active wallets</div>
            <div className="text-xl font-semibold text-white">{stats.walletCount}</div>
          </div>
        </div>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-medium text-white">Recent channel activity</h2>
        <p className="mb-3 text-xs text-gray-500">
          Telegram mentions from social-ingest (excludes tracked-wallet poll). Live logs:{" "}
          <code className="text-gray-400">docker compose logs -f social-ingest</code>
        </p>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Token</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2 text-xs text-gray-400">{e.occurred_at}</td>
                  <td className="px-3 py-2">{e.source}</td>
                  <td className="px-3 py-2">{e.channel_label ?? "—"}</td>
                  <td className="px-3 py-2">{e.event_type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.token_address}</td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-gray-500">
                    No Telegram events in the last 24h — check social-ingest is running and
                    channels are active
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-white">Tracked wallets</h2>
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
            placeholder="Wallet address"
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
          />
          <input
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
            placeholder="Label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
            onClick={() => void addWallet()}
          >
            Add wallet
          </button>
          <button
            type="button"
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Last poll</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2">{w.label}</td>
                  <td className="px-3 py-2 font-mono text-xs">{w.address}</td>
                  <td className="px-3 py-2">{w.tier}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {w.last_polled_at ?? "—"}
                    {w.last_poll_error ? ` (${w.last_poll_error})` : ""}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => void removeWallet(w.address)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-white">Token rollups</h2>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Mentions 30m</th>
                <th className="px-3 py-2">Channels</th>
                <th className="px-3 py-2">Wallet buys 1h</th>
                <th className="px-3 py-2">Top source</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rollups.map((r) => (
                <tr key={r.token_address} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2 font-mono text-xs">{r.token_address}</td>
                  <td className="px-3 py-2">{r.mention_count_30m}</td>
                  <td className="px-3 py-2">{r.unique_channel_count_30m}</td>
                  <td className="px-3 py-2">{r.smart_wallet_buy_count_1h}</td>
                  <td className="px-3 py-2">{r.top_source ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">{r.updated_at}</td>
                </tr>
              ))}
              {rollups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-gray-500">
                    No rollups yet — run social ingest + POST /api/social/rollup
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
