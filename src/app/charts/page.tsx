"use client";

import React, { useMemo, useState, useEffect, Suspense } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";

function parseAddresses(param: string | null): string[] {
  if (!param) return [];
  // Support comma or pipe separated lists and trim whitespace
  return param
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ChartsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const addresses = parseAddresses(searchParams.get("addresses"));
  const interval = searchParams.get("interval") || "5";

  const STORAGE_KEY = "charts_saved_addresses";

  function getSavedCharts(): string[] {
    try {
      const raw =
        typeof window !== "undefined"
          ? localStorage.getItem(STORAGE_KEY)
          : null;
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter((s: any) => typeof s === "string" && s.length > 0)
        : [];
    } catch {
      return [];
    }
  }

  function saveChartList(addrs: string[]): void {
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(addrs));
      }
    } catch {
      // ignore
    }
  }

  const [charts, setCharts] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(charts));
  const [reason, setReason] = useState<string>("continue");
  const [status, setStatus] = useState<string>("");
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const [newAddrs, setNewAddrs] = useState<string>("");

  function updateBrowserAddresses(nextList: string[]) {
    try {
      const params = new URLSearchParams(searchParams.toString());
      if (nextList.length > 0) {
        params.set("addresses", nextList.join(","));
      } else {
        params.delete("addresses");
      }
      // Keep existing params (like interval) while updating addresses
      const query = params.toString();
      const nextUrl = query ? `${pathname}?${query}` : `${pathname}`;
      router.replace(nextUrl);
      console.debug("[Charts] URL updated with addresses", {
        nextList,
        nextUrl,
      });
    } catch (e) {
      console.warn("[Charts] Failed to update URL addresses", e);
    }
  }

  function handleSaveMint(addr: string) {
    try {
      const saved = getSavedCharts();
      const union = Array.from(new Set([...saved, addr]));
      saveChartList(union);
      setStatus(`Saved ${addr} to chart list`);
      console.debug("[Charts] Saved single mint", { addr });
    } catch (e: any) {
      setStatus(`Save failed: ${e?.message || "unknown"}`);
    }
  }

  function handleRemoveMint(addr: string) {
    try {
      setCharts((prev: string[]) => {
        const next = prev.filter((a: string) => a !== addr);
        updateBrowserAddresses(next);
        console.debug("[Charts] Removed single mint from charts", {
          addr,
          next,
        });
        return next;
      });
      setSelected((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(addr);
        return next;
      });
      // Also remove from saved list to prevent reintroduction on refresh
      const saved = getSavedCharts();
      const filtered = saved.filter((a: string) => a !== addr);
      if (filtered.length !== saved.length) {
        saveChartList(filtered);
        console.debug("[Charts] Removed single mint from saved list", { addr });
      }
      setStatus(
        `Removed ${addr} from charts${filtered.length !== saved.length ? " and saved list" : ""}`,
      );
    } catch (e: any) {
      setStatus(`Remove failed: ${e?.message || "unknown"}`);
    }
  }

  function handleAddAddresses() {
    try {
      const parsed: string[] = parseAddresses(newAddrs);
      if (parsed.length === 0) {
        setStatus("Nothing to add");
        return;
      }
      setCharts((prev: string[]) => {
        const union = Array.from(new Set([...prev, ...parsed]));
        const list = union.slice(0, 50);
        updateBrowserAddresses(list);
        console.debug("[Charts] Added addresses", {
          added: parsed,
          next: list,
        });
        return list;
      });
      setSelected((prev: Set<string>) => {
        const next = new Set(prev);
        parsed.forEach((a: string) => next.add(a));
        return next;
      });
      setNewAddrs("");
      setStatus(
        `Added ${parsed.length} address${parsed.length !== 1 ? "es" : ""}`,
      );
    } catch (e: any) {
      setStatus(`Add failed: ${e?.message || "unknown"}`);
    }
  }

  function handleRestoreSaved() {
    try {
      const saved = getSavedCharts();
      if (saved.length === 0) {
        setStatus("No saved charts found");
        return;
      }
      setCharts((prev: string[]) => {
        const union = Array.from(new Set([...prev, ...saved]));
        const list = union.slice(0, 50);
        updateBrowserAddresses(list);
        console.debug("[Charts] Restored saved addresses", {
          savedCount: saved.length,
          next: list,
        });
        return list;
      });
      setSelected((prev: Set<string>) => {
        const next = new Set(prev);
        saved.forEach((a: string) => next.add(a));
        return next;
      });
      setStatus(
        `Restored ${saved.length} saved address${saved.length !== 1 ? "es" : ""}`,
      );
    } catch (e: any) {
      setStatus(`Restore failed: ${e?.message || "unknown"}`);
    }
  }

  const selectedCount = useMemo(() => selected.size, [selected]);

  async function applyStopReason(targets: string[]) {
    setStatus("");
    try {
      const resp = await fetch(`/api/mcap-tracking?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: targets, reason }),
      });
      const json = await resp.json();
      if (!resp.ok || json.success === false) {
        setStatus(`Failed: ${json.error || resp.status}`);
      } else {
        setStatus(
          `Updated ${json.updated} tokens (${reason === "continue" ? "continue" : reason})`,
        );
        // If we stopped tokens, remove them from the current list
        if (reason === "rug") {
          const removeSet = new Set(targets);
          setCharts((prev: string[]) => {
            const next = prev.filter((a: string) => !removeSet.has(a));
            // Update browser path to exclude removed mints
            updateBrowserAddresses(next);
            console.debug("[Charts] Removed tokens due to rug", {
              removed: targets,
              next,
            });
            return next;
          });
          setSelected((prev: Set<string>) => {
            const next = new Set(prev);
            targets.forEach((a: string) => next.delete(a));
            return next;
          });
        }
      }
    } catch (e: any) {
      setStatus(`Error: ${e?.message || "unknown"}`);
    }
  }

  function handleSaveList() {
    try {
      const saved = getSavedCharts();
      const union = Array.from(new Set([...saved, ...charts]));
      saveChartList(union);
      setStatus(`Saved ${union.length} tokens to chart list`);
    } catch (e: any) {
      setStatus(`Save failed: ${e?.message || "unknown"}`);
    }
  }

  // Fetch token symbols for displayed addresses
  useEffect(() => {
    let cancelled = false;
    async function fetchSymbols() {
      try {
        if (charts.length === 0) {
          setSymbols({});
          return;
        }
        const resp = await fetch("/api/jupiter/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mints: charts }),
        });
        const json = await resp.json();
        const map: Record<string, string> = {};
        const results = json?.results || {};
        Object.entries(results).forEach(([mint, result]: [string, any]) => {
          const symbol = result?.data?.symbol || "TOKEN";
          map[mint] = symbol;
        });
        if (!cancelled) setSymbols(map);
      } catch (e) {
        // Silently ignore and keep addresses as fallback
        if (!cancelled) setSymbols({});
      }
    }
    fetchSymbols();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charts.join("|")]);

  // Initialize charts from query + saved list
  useEffect(() => {
    const saved = getSavedCharts();
    const union = Array.from(new Set([...(addresses || []), ...saved]));
    const list = union.slice(0, 50);
    setCharts(list);
    setSelected(new Set(list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.join("|")]);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Charts</h1>
        <p className="text-gray-400 mb-4">
          Showing {charts.length} chart{charts.length !== 1 ? "s" : ""} •
          interval {interval}
        </p>

        {charts.length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-4">
            <p className="text-gray-300 text-sm mb-3">
              No charts added — add more.
            </p>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 text-sm bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white"
                value={newAddrs}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewAddrs(e.target.value)
                }
                placeholder="Paste mint addresses (comma or pipe separated)"
              />
              <button
                className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                onClick={handleAddAddresses}
              >
                Add
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white"
                onClick={handleRestoreSaved}
              >
                Restore saved
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <button
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => setSelected(new Set(charts))}
                >
                  Select all
                </button>
                <button
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
                <span className="text-xs text-gray-300">
                  Selected: {selectedCount}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-300">Action</label>
                <select
                  value={reason}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setReason(e.target.value)
                  }
                  className="text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1"
                >
                  <option value="continue">Continue</option>
                  <option value="rug">Stop (rug)</option>
                </select>
                <button
                  className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                  disabled={selectedCount === 0}
                  onClick={() => applyStopReason(Array.from(selected))}
                >
                  Apply to selected
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                  onClick={() => applyStopReason(charts)}
                >
                  Apply to all
                </button>
                <button
                  className="ml-2 px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white"
                  onClick={handleSaveList}
                >
                  Save list
                </button>
                <input
                  className="ml-2 w-64 text-sm bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white"
                  value={newAddrs}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setNewAddrs(e.target.value)
                  }
                  placeholder="Add more mints (comma or pipe)"
                />
                <button
                  className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                  onClick={handleAddAddresses}
                >
                  Add
                </button>
              </div>
            </div>
            {status && (
              <div className="mb-3 text-xs text-gray-300">{status}</div>
            )}

            <div
              className="grid"
              style={{
                gridTemplateColumns: "repeat(auto-fill, 400px)",
                gap: "12px",
              }}
            >
              {charts.map((addr: string) => (
                <div
                  key={addr}
                  className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700"
                  style={{ width: 400, height: 200 }}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                    <div className="text-sm font-medium">
                      {symbols[addr] || addr}
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-xs text-gray-300">
                        <input
                          type="checkbox"
                          checked={selected.has(addr)}
                          onChange={(
                            e: React.ChangeEvent<HTMLInputElement>,
                          ) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(addr);
                            else next.delete(addr);
                            setSelected(next);
                          }}
                        />
                        Select
                      </label>
                      <button
                        className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white"
                        onClick={() => handleSaveMint(addr)}
                      >
                        Save
                      </button>
                      <button
                        className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white"
                        onClick={() => handleRemoveMint(addr)}
                      >
                        Remove
                      </button>
                      <a
                        href={`/chart/${addr}`}
                        className="text-xs text-blue-400 hover:text-blue-300 underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open full
                      </a>
                    </div>
                  </div>
                  <iframe
                    src={`https://www.gmgn.cc/kline/sol/${addr}?interval=${interval}`}
                    title={`Chart ${addr}`}
                    frameBorder={0}
                    className="w-full"
                    style={{ height: 200 }}
                    allowFullScreen
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function MultiChartsPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-center">Loading charts...</div>}
    >
      <ChartsContent />
    </Suspense>
  );
}
