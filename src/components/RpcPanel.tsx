"use client";

import React from "react";
import type { RpcDiagnosticRow } from "@/app/api/rpc/diagnostics/route";
import type { RpcEndpoint, TokenFetchMeta } from "@/contexts/RpcContext";

type RpcPanelProps = {
  expanded: boolean;
  onToggle: () => void;
  endpoints: RpcEndpoint[];
  selectedEndpointIndex: number;
  onSelectEndpoint: (index: number) => void;
  autoSelectBest: boolean;
  onAutoSelectBestChange: (enabled: boolean) => void;
  onTestAll: () => void;
  isRunningDiagnostics: boolean;
  diagnostics: RpcDiagnosticRow[];
  lastFetchMeta: TokenFetchMeta | null;
  incompleteRpcBanner: string | null;
};

export default function RpcPanel({
  expanded,
  onToggle,
  endpoints,
  selectedEndpointIndex,
  onSelectEndpoint,
  autoSelectBest,
  onAutoSelectBestChange,
  onTestAll,
  isRunningDiagnostics,
  diagnostics,
  lastFetchMeta,
  incompleteRpcBanner,
}: RpcPanelProps) {
  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 hover:bg-gray-750 text-left"
      >
        <span className="text-sm font-semibold text-gray-200">RPC</span>
        <span className="text-xs text-gray-400">
          {endpoints[selectedEndpointIndex]?.provider ?? "Loading..."}
          {lastFetchMeta
            ? ` · ${lastFetchMeta.rawAccountCount} accounts · ${lastFetchMeta.latencyMs}ms`
            : ""}
        </span>
      </button>

      {expanded && (
        <div className="p-4 space-y-4 bg-gray-900/50 border-t border-gray-700">
          {incompleteRpcBanner && (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-900/20 px-3 py-2 text-sm text-yellow-200">
              {incompleteRpcBanner}
            </div>
          )}

          {lastFetchMeta?.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-900/20 px-3 py-2 text-sm text-red-200">
              Fetch error: {lastFetchMeta.error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <label className="text-sm text-gray-300 shrink-0">Endpoint</label>
            <select
              value={selectedEndpointIndex}
              onChange={(e) => onSelectEndpoint(Number.parseInt(e.target.value, 10))}
              className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
            >
              {endpoints.map((ep) => (
                <option key={ep.index} value={ep.index}>
                  {ep.provider} — {ep.sanitizedUrl}
                  {ep.responseTime ? ` (${ep.responseTime}ms)` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={autoSelectBest}
                onChange={(e) => onAutoSelectBestChange(e.target.checked)}
                className="rounded border-gray-600"
              />
              Auto-select best RPC
            </label>
            <button
              type="button"
              onClick={onTestAll}
              disabled={isRunningDiagnostics}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm disabled:opacity-50"
            >
              {isRunningDiagnostics ? "Testing..." : "Test all RPCs"}
            </button>
            <a
              href="/dev/rpc-tester"
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Full RPC tester
            </a>
          </div>

          {diagnostics.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left text-gray-300">
                <thead>
                  <tr className="border-b border-gray-700 text-gray-400">
                    <th className="py-2 pr-3">Provider</th>
                    <th className="py-2 pr-3">Slot ms</th>
                    <th className="py-2 pr-3">Accounts ms</th>
                    <th className="py-2 pr-3">Accounts</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.map((row) => (
                    <tr
                      key={row.index}
                      className={`border-b border-gray-800 ${
                        row.index === selectedEndpointIndex ? "bg-gray-800/60" : ""
                      }`}
                    >
                      <td className="py-2 pr-3">{row.provider}</td>
                      <td className="py-2 pr-3">{row.getSlotMs}</td>
                      <td className="py-2 pr-3">{row.getParsedTokenAccountsMs}</td>
                      <td className="py-2 pr-3">{row.rawAccountCount}</td>
                      <td className="py-2">
                        {row.healthy ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-red-400" title={row.error}>
                            Error
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
