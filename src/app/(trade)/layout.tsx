"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import Footer from "@/components/Footer";
import NavigationTabs from "@/components/NavigationTabs";
import TradingHistory from "@/components/TradingHistory";
import PnLTracker from "@/components/PnLTracker";
import WalletConnectGate from "@/components/WalletConnectGate";
import DevRouteGate from "@/components/DevRouteGate";
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

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [activeOverlayTab, setActiveOverlayTab] = useState<string | null>(
    null,
  );

  return (
    <main className="min-h-screen bg-black py-8 pb-24 md:pb-8">
      <div className="container mx-auto px-4">
        <NavigationTabs
          activeOverlayTab={activeOverlayTab}
          onTabSelect={setActiveOverlayTab}
        />

        <div className="max-w-8xl mx-auto min-h-[300px] mt-4 relative">
          {activeOverlayTab === "history" && (
            <WalletConnectGate title="Connect to view history">
              <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
                <h2 className="text-xl font-bold mb-4 text-white">
                  Trading History
                </h2>
                <TradingHistory />
              </div>
            </WalletConnectGate>
          )}

          {activeOverlayTab === "pnl" && (
            <WalletConnectGate title="Connect to view P&amp;L">
              <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
                <h2 className="text-xl font-bold mb-4 text-white">
                  Profit & Loss Tracker
                </h2>
                <PnLTracker />
              </div>
            </WalletConnectGate>
          )}

          <div className="w-full mb-8">
            <RouteAccessGate>{children}</RouteAccessGate>
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
