"use client";

import React from "react";

type GmgnChartEmbedProps = {
  tokenAddress: string;
  interval?: string;
  theme?: "dark" | "light";
  className?: string;
  height?: number | string;
  title?: string;
};

/** Shared GMGN kline iframe embed used across Signals tabs. */
export default function GmgnChartEmbed({
  tokenAddress,
  interval = "5",
  theme,
  className = "w-full h-full rounded-lg",
  height = "100%",
  title,
}: GmgnChartEmbedProps) {
  const themeParam = theme ? `&theme=${theme}` : "";
  const src = `https://www.gmgn.cc/kline/sol/${tokenAddress}?interval=${interval}${themeParam}`;

  return (
    <iframe
      src={src}
      className={className}
      style={{ border: "none", height }}
      title={title ?? `GMGN Chart - ${tokenAddress.slice(0, 8)}`}
      allowFullScreen
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
    />
  );
}
