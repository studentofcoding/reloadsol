"use client";

import React, { useMemo } from "react";
import { getGmgnKlineUrl, type GmgnChain } from "@/utils/gmgn";

type GmgnChartEmbedProps = {
  tokenAddress: string;
  interval?: string;
  theme?: "dark" | "light";
  chain?: GmgnChain;
  className?: string;
  height?: number | string;
  title?: string;
};

/** Build the GMGN kline embed URL once per (token/chain/interval) change. */
function useGmgnKlineSrc(
  tokenAddress: string,
  interval: string,
  theme: "dark" | "light" | undefined,
  chain: GmgnChain | undefined,
): string {
  return useMemo(
    () => getGmgnKlineUrl(tokenAddress, { interval, theme, chain }),
    [tokenAddress, interval, theme, chain],
  );
}

/**
 * Shared GMGN kline iframe embed used across Signals tabs.
 *
 * The iframe src is stable per (token/interval/chain): it is NOT re-keyed or
 * remounted on unrelated re-renders (e.g. buyState changes), which avoids
 * tearing down a live GMGN TradingView chart mid-session and triggering the
 * GMGN-side `setSymbolParams`/`_onBeforeModifySeries` crash. To force a hard
 * reload for a different token, callers should pass a different `tokenAddress`
 * (or remount with a key at the call site).
 */
export default function GmgnChartEmbed({
  tokenAddress,
  interval = "5",
  theme,
  chain,
  className = "w-full h-full rounded-lg",
  height = "100%",
  title,
}: GmgnChartEmbedProps) {
  const src = useGmgnKlineSrc(tokenAddress, interval, theme, chain);

  return (
    <iframe
      src={src}
      className={className}
      style={{ border: "none", height }}
      title={title ?? `GMGN Chart - ${tokenAddress.slice(0, 8)}`}
      allowFullScreen
      loading="lazy"
    />
  );
}
