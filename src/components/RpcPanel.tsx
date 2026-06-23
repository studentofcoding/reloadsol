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

function slotStatus(ep: RpcEndpoint, row?: RpcDiagnosticRow): string {
  if (row) return row.slotHealthy ? "OK" : "Error";
  if (ep.slotHealthy === true) return "OK";
  if (ep.slotHealthy === false) return "Error";
  return "—";
}

function indexStatus(ep: RpcEndpoint, row?: RpcDiagnosticRow): {
  label: string;
  title?: string;
} {
  if (row) {
    return row.indexHealthy
      ? { label: "OK" }
      : { label: "Error", title: row.indexError ?? row.error };
  }
  if (ep.indexHealthy === true) return { label: "OK" };
  if (ep.indexHealthy === false) {
    return { label: "Error", title: ep.indexError };
  }
  return { label: "—" };
}

function EndpointRow({
  ep,
  row,
  isSelected,
  onSelect,
  showSelectHint,
}: {
  ep: RpcEndpoint;
  row?: RpcDiagnosticRow;
  isSelected: boolean;
  onSelect: () => void;
  showSelectHint: boolean;
}) {
  const slot = slotStatus(ep, row);
  const index = indexStatus(ep, row);
  const accounts = row?.rawAccountCount ?? "—";
  const latency =
    row?.getParsedTokenAccountsMs ??
    ep.responseTime ??
    undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
        isSelected
          ? "border-blue-500/60 bg-blue-900/20"
          : "border-gray-700 bg-gray-800/40 hover:bg-gray-800"
      } ${showSelectHint ? "cursor-pointer" : "cursor-default"}`}
      disabled={!showSelectHint}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-white">
            {ep.provider}
            {isSelected && (
              <span className="ml-2 text-xs text-blue-300">Active</span>
            )}
          </div>
          <div className="text-xs text-gray-400 truncate">{ep.sanitizedUrl}</div>
        </div>
        <div className="flex flex-wrap gap-3 text-xs shrink-0">
          <span className="text-gray-400">
            Slot:{" "}
            <span className={slot === "OK" ? "text-green-400" : slot === "Error" ? "text-red-400" : "text-gray-500"}>
              {slot}
            </span>
          </span>
          <span className="text-gray-400" title={index.title}>
            Index:{" "}
            <span
              className={
                index.label === "OK"
                  ? "text-green-400"
                  : index.label === "Error"
                    ? "text-red-400"
                    : "text-gray-500"
              }
            >
              {index.label}
            </span>
          </span>
          <span className="text-gray-400">
            Accounts: <span className="text-gray-200">{accounts}</span>
          </span>
          {latency !== undefined && (
            <span className="text-gray-400">
              {latency}ms
            </span>
          )}
        </div>
      </div>
      {index.title && (
        <p className="mt-1 text-xs text-red-300/90">{index.title}</p>
      )}
    </button>
  );
}

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
  const multipleEndpoints = endpoints.length > 1;
  const diagnosticByIndex = new Map(diagnostics.map((row) => [row.index, row]));

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
          {endpoints.length > 1 ? ` · ${endpoints.length} endpoints` : ""}
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

          <div className="space-y-2">
            <label className="text-sm text-gray-300">
              {multipleEndpoints ? "Endpoints" : "Endpoint"}
            </label>
            <div className="space-y-2">
              {endpoints.map((ep) => (
                <EndpointRow
                  key={ep.index}
                  ep={ep}
                  row={diagnosticByIndex.get(ep.index)}
                  isSelected={ep.index === selectedEndpointIndex}
                  onSelect={() => onSelectEndpoint(ep.index)}
                  showSelectHint={multipleEndpoints}
                />
              ))}
            </div>
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
                    <th className="py-2 pr-3">Slot</th>
                    <th className="py-2 pr-3">Index</th>
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
                      <td className="py-2 pr-3">
                        {row.slotHealthy ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-red-400" title={row.slotError}>
                            Error
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {row.indexHealthy ? (
                          <span className="text-green-400">OK</span>
                        ) : (
                          <span className="text-red-400" title={row.indexError}>
                            Error
                          </span>
                        )}
                      </td>
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
