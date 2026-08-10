import React from "react";
import Footer from "@/components/Footer";
import GlobalWatchlistBar from "@/components/GlobalWatchlistBar";
import TradeShellClient from "./trade-shell-client";

/**
 * (trade) App Shell — static server component.
 *
 * Under cacheComponents/partialPrefetching (Next 16.3 Instant Navigations)
 * this layout is included in the prefetched App Shell per route, so the shared
 * chrome (nav tabs + watchlist bar + footer) renders instantly on client
 * navigation. Client-only state (nav tab bar, overlay tabs, route gates,
 * TradingDataProvider) lives in TradeShellClient below this boundary.
 */
export default function TradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-black py-8 pb-24 md:pb-8">
      <div className="container mx-auto px-4">
        <GlobalWatchlistBar />

        <TradeShellClient>{children}</TradeShellClient>
      </div>

      <Footer />
    </main>
  );
}
