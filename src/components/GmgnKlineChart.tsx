"use client";

import { useState } from "react";
import { getGmgnKlineUrl, getGmgnTokenUrl, type GmgnChain } from "@/utils/gmgn";

interface GmgnKlineChartProps {
  tokenMint: string;
  symbol?: string;
  height?: number;
  interval?: string;
  chain?: GmgnChain;
  className?: string;
}

export default function GmgnKlineChart({
  tokenMint,
  symbol,
  height = 280,
  interval = "5",
  chain,
  className = "",
}: GmgnKlineChartProps) {
  const [loading, setLoading] = useState(true);
  const chartUrl = getGmgnKlineUrl(tokenMint, { interval, theme: "dark", chain });

  return (
    <div className={`relative rounded-lg overflow-hidden border border-gray-700 bg-black ${className}`}>
      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-gray-900/90 z-10"
          style={{ height }}
        >
          <span className="text-gray-400 text-sm">Loading GMGN chart…</span>
        </div>
      )}
      <iframe
        src={chartUrl}
        className="w-full border-0"
        style={{ height, minHeight: height }}
        title={`GMGN chart${symbol ? ` — ${symbol}` : ""}`}
        loading="lazy"
        onLoad={() => setLoading(false)}
        onError={() => setLoading(false)}
      />
      <a
        href={getGmgnTokenUrl(tokenMint, chain)}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-2 right-2 z-20 px-2 py-1 text-xs bg-black/70 hover:bg-black text-gray-300 rounded border border-gray-600"
      >
        Open on GMGN ↗
      </a>
    </div>
  );
}
