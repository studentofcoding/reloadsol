"use client";

import React from "react";
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

/** Shared GMGN kline iframe embed used across Signals tabs. */
export default function GmgnChartEmbed({
  tokenAddress,
  interval = "5",
  theme,
  chain,
  className = "w-full h-full rounded-lg",
  height = "100%",
  title,
}: GmgnChartEmbedProps) {
  const src = getGmgnKlineUrl(tokenAddress, { interval, theme, chain });

  return (
    <iframe
      key={`${src}`}
      src={src}
      className={className}
      style={{ border: "none", height }}
      title={title ?? `GMGN Chart - ${tokenAddress.slice(0, 8)}`}
      allowFullScreen
      loading="lazy"
    />
  );
}
