"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import NavigationTabs from "@/components/NavigationTabs";
import TradingHistory from "@/components/TradingHistory";
import PnLTracker from "@/components/PnLTracker";
import WalletConnectGate from "@/components/WalletConnectGate";
import NetworkRouteGate from "@/components/NetworkRouteGate";
import DevRouteGate from "@/components/DevRouteGate";
import TradingDataProvider from "@/components/TradingDataProvider";
import TradeProviderBar from "@/components/TradeProviderBar";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import {
  isDevRoute,
  isWalletRequiredRoute,
} from "@/config/route-access";

function RouteAccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";

  if (isDevRoute(pathname)) {
    return <DevRouteGate>{children}</DevRouteGate>;
  }

  if (isWalletRequiredRoute(pathname)) {
    return <WalletConnectGate>{children}</WalletConnectGate>;
  }

  return <>{children}</>;
}

/**
 * Client boundary for the (trade) App Shell.
 *
 * Under cacheComponents/partialPrefetching the (trade)/layout.tsx is a static
 * server component so the shell chrome can be included in the prefetched App
 * Shell. Everything that needs client state — the interactive nav tab bar
 * (with history/pnl overlay tabs), route gates, network gates, and the
 * TradingDataProvider — lives here, below the shared server layout.
 */
export default function TradeShellClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const { network } = useAppNetwork();
  const [activeOverlayTab, setActiveOverlayTab] = useState<string | null>(
    null,
  );

  return (
    <TradingDataProvider>
      <NavigationTabs
        activeOverlayTab={activeOverlayTab}
        onTabSelect={setActiveOverlayTab}
      />

      <div className="max-w-8xl mx-auto min-h-[300px] mt-4 relative">
        {activeOverlayTab === "history" && (
          <WalletConnectGate
            title="Connect to view history"
            showTrending={false}
            connectLabel="Connect Wallet"
          >
            <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
              <h2 className="text-xl font-bold mb-4 text-white">
                Trading History
                {network === "robinhood" ? " (Robinhood)" : ""}
              </h2>
              <TradingHistory />
            </div>
          </WalletConnectGate>
        )}

        {activeOverlayTab === "pnl" && (
          <WalletConnectGate
            title="Connect to view P&L"
            showTrending={false}
            connectLabel="Connect Wallet"
          >
            <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
              <h2 className="text-xl font-bold mb-4 text-white">
                Profit & Loss Tracker
                {network === "robinhood" ? " (ETH)" : ""}
              </h2>
              <PnLTracker />
            </div>
          </WalletConnectGate>
        )}

        <div className="w-full mb-8">
          <NetworkRouteGate>
            <RouteAccessGate>{children}</RouteAccessGate>
          </NetworkRouteGate>
          {network === "sol" ? <TradeProviderBar /> : null}
        </div>
      </div>
    </TradingDataProvider>
  );
}
