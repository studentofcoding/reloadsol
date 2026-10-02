"use client";

import Link from "next/link";
import { rosterChartPath, rosterTokenLabel } from "@/components/signals/roster-token-label";

/**
 * Sol roster chip for the Buy / Sell screens. The label is the primary action
 * (`onSelect`: add-to-buy or toggle-for-sell, as before), and a small link
 * opens the reloadsol chart for that mint in a new tab.
 */
export default function RosterSolChip({
  mint,
  symbol,
  metaSymbol,
  onSelect,
  selected = false,
}: {
  mint: string;
  symbol?: string | null;
  metaSymbol?: string | null;
  onSelect: () => void;
  selected?: boolean;
}) {
  const label = rosterTokenLabel({ mint, symbol, metaSymbol });
  return (
    <span
      className={`inline-flex items-stretch overflow-hidden rounded-lg text-xs text-gray-200 ${
        selected ? "bg-gray-700 ring-1 ring-white/30" : "bg-gray-800"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={mint}
        aria-pressed={selected}
        className="px-2 py-1 hover:bg-gray-700"
      >
        {label}
      </button>
      <Link
        href={rosterChartPath(mint)}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open chart · ${mint}`}
        aria-label={`Open chart for ${label}`}
        className="border-l border-white/10 px-1.5 py-1 text-gray-400 hover:bg-gray-700 hover:text-white"
      >
        ↗
      </Link>
    </span>
  );
}
