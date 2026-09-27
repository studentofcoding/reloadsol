"use client";

import Link from "next/link";
import { rosterChartPath, rosterTokenLabel } from "@/components/signals/roster-token-label";

/** Sol roster token label. Click opens the reloadsol chart for that mint. */
export default function RosterSolChartLink({
  mint,
  symbol,
  metaSymbol,
  className,
}: {
  mint: string;
  symbol?: string | null;
  metaSymbol?: string | null;
  className?: string;
}) {
  const label = rosterTokenLabel({ mint, symbol, metaSymbol });
  return (
    <Link
      href={rosterChartPath(mint)}
      target="_blank"
      rel="noopener noreferrer"
      title={mint}
      className={className}
    >
      {label}
    </Link>
  );
}
