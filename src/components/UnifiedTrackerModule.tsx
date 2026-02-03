"use client";

import React, { useState } from "react";
import PnLTracker from "./PnLTracker";
import TradingHistory from "./TradingHistory";

interface UnifiedTrackerModuleProps {
  defaultTab?: "pnl" | "history";
  className?: string;
}

export default function UnifiedTrackerModule({
  defaultTab = "pnl",
  className = "",
}: UnifiedTrackerModuleProps) {
  const [activeTab, setActiveTab] = useState<"pnl" | "history">(defaultTab);

  return (
    <div
      className={`bg-gray-900 rounded-xl border border-gray-700 overflow-hidden ${className}`}
    >
      {/* Tab Header */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setActiveTab("pnl")}
          className={`flex-1 py-4 text-sm font-medium transition-colors relative ${
            activeTab === "pnl"
              ? "text-blue-400 bg-gray-800/50"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/30"
          }`}
        >
          Active Positions & PnL
          {activeTab === "pnl" && (
            <div className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-400" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={`flex-1 py-4 text-sm font-medium transition-colors relative ${
            activeTab === "history"
              ? "text-purple-400 bg-gray-800/50"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/30"
          }`}
        >
          Trading History
          {activeTab === "history" && (
            <div className="absolute bottom-0 left-0 w-full h-0.5 bg-purple-400" />
          )}
        </button>
      </div>

      {/* Content Area */}
      <div className="p-4 min-h-[400px]">
        <div className={activeTab === "pnl" ? "block" : "hidden"}>
          <PnLTracker />
        </div>
        <div className={activeTab === "history" ? "block" : "hidden"}>
          <TradingHistory />
        </div>
      </div>
    </div>
  );
}
