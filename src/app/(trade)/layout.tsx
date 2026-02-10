"use client";

import React, { useState } from "react";
import ConnectionStatus from "@/components/ConnectionStatus";
import Footer from "@/components/Footer";
import NavigationTabs from "@/components/NavigationTabs";
import { useWallet } from "@/components/WalletProvider";
import TradingHistory from "@/components/TradingHistory";
import PnLTracker from "@/components/PnLTracker";

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { connected, publicKey } = useWallet();
  const [activeOverlayTab, setActiveOverlayTab] = useState<string | null>(null);

  return (
    <main className="min-h-screen bg-black py-8 pb-24 md:pb-8">
      <div className="container mx-auto px-4">
        {/* Navigation Tabs */}
        <NavigationTabs
          activeOverlayTab={activeOverlayTab}
          onTabSelect={setActiveOverlayTab}
        />

        <div className="max-w-8xl mx-auto min-h-[300px] mt-4 relative">
          {/* Overlays - Rendered below main content */}
          {activeOverlayTab === "history" && (
            <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
              <h2 className="text-xl font-bold mb-4 text-white">
                Trading History
              </h2>
              <TradingHistory />
            </div>
          )}

          {activeOverlayTab === "pnl" && (
            <div className="w-full mt-8 border-t border-gray-800 pt-8 max-w-6xl mx-auto">
              <h2 className="text-xl font-bold mb-4 text-white">
                Profit & Loss Tracker
              </h2>
              <PnLTracker />
            </div>
          )}

          {/* Main Content - Always visible but might be pushed down or overlayed */}
          <div className="w-full mb-8">{children}</div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
