"use client";

import React, { useState } from "react";
import type { RawSectionDataTier } from "@/strategies/token-locate";

type RawJsonPanelProps = {
  label: string;
  source: string;
  recordLabel?: string | null;
  dataTier?: RawSectionDataTier;
  data: unknown;
  defaultOpen?: boolean;
};

function labelBadgeClass(label: string): string {
  switch (label) {
    case "rugged":
      return "bg-red-900/60 text-red-300 border-red-700";
    case "potential":
      return "bg-amber-900/60 text-amber-300 border-amber-700";
    case "valid":
    case "traded_live":
      return "bg-green-900/60 text-green-300 border-green-700";
    case "watching":
      return "bg-blue-900/60 text-blue-300 border-blue-700";
    default:
      return "bg-gray-800 text-gray-300 border-gray-600";
  }
}

function dataTierBadgeClass(tier: RawSectionDataTier): string {
  switch (tier) {
    case "raw":
      return "bg-gray-700/80 text-gray-200 border-gray-600";
    case "jupiter_enriched":
      return "bg-purple-900/60 text-purple-200 border-purple-700";
    case "internal":
      return "bg-blue-900/60 text-blue-200 border-blue-700";
  }
}

function dataTierLabel(tier: RawSectionDataTier): string {
  switch (tier) {
    case "raw":
      return "Raw";
    case "jupiter_enriched":
      return "Jupiter enrichment";
    case "internal":
      return "Internal DB";
  }
}

export default function RawJsonPanel({
  label,
  source,
  recordLabel,
  dataTier,
  data,
  defaultOpen = true,
}: RawJsonPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-gray-800/40"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-white">{label}</span>
            {dataTier ? (
              <span
                className={`rounded border px-2 py-0.5 text-xs ${dataTierBadgeClass(dataTier)}`}
              >
                {dataTierLabel(dataTier)}
              </span>
            ) : null}
            {recordLabel ? (
              <span
                className={`rounded border px-2 py-0.5 text-xs uppercase ${labelBadgeClass(recordLabel)}`}
              >
                {recordLabel}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-gray-500">{source}</p>
        </div>
        <span className="shrink-0 text-gray-400">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="border-t border-gray-700 px-4 py-3">
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
              }}
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white transition-colors hover:bg-blue-700"
            >
              Copy JSON
            </button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-black/50 p-4 font-mono text-sm text-green-400">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
