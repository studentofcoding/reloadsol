"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ScrollableMenuRow from "@/components/ScrollableMenuRow";
import WalletBalance from "@/components/WalletBalance";
import RhWalletBalance from "@/components/RhWalletBalance";
import { useDevWalletAccess } from "@/components/WalletProvider";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { routeSupportsNetwork } from "@/config/route-network";
import { useIsClient } from "@/hooks/useIsClient";
import { useIsMobile } from "@/hooks/useIsMobile";

export default function NavigationTabs({
  activeOverlayTab,
  onTabSelect,
}: {
  activeOverlayTab?: string | null;
  onTabSelect?: (tab: string | null) => void;
}) {
  const pathname = usePathname();
  const isDevUser = useDevWalletAccess();
  const { network } = useAppNetwork();
  const can = (path: string) => routeSupportsNetwork(path, network);
  const mounted = useIsClient();
  const isMobile = useIsMobile();
  const showSolChrome = network === "sol";
  const showPortfolioChrome = true; // Batch 3: history/PnL on both networks

  const isActive = (path: string) => {
    // Check if it's an overlay tab (no leading slash)
    if (!path.startsWith("/")) {
      return activeOverlayTab === path;
    }
    // Check if it's a route tab
    return (pathname || "").startsWith(path);
  };
  const showMainTabs = [
    "/buy",
    "/sell",
    "/swap",
    "/history",
    "/pnl",
    "/search-token",
    "/dev/signals",
    "/dev/algo-tester",
    "/dev/dlmm",
    "/dev/social",
    "/dev/strategies",
    "/dev/token-search",
    "/dev/ohlc-labels",
    "/dev/arbitrage",
  ].some((path) => (pathname || "").startsWith(path));

  const handleTabClick = (tab: string) => {
    if (onTabSelect) {
      onTabSelect(activeOverlayTab === tab ? null : tab);
    }
  };

  return (
    <div className="w-full relative z-50">
      {/* Desktop Navigation */}
      <div className="sticky top-0 z-40 hidden bg-black/85 backdrop-blur-sm border-b border-white/5 px-2 pt-2 md:block">
        <div
          className={`${mounted && isDevUser ? "max-w-6xl" : "max-w-4xl"} mx-auto mb-2`}
        >
          <div className="flex items-center justify-between h-full mb-4 gap-4">
          <ScrollableMenuRow className="min-w-0 flex-1" innerClassName="gap-2" bleed={false}>
            {/* Main Trading Tabs */}
            {showMainTabs && (
              <>
                {can("/sell") ? (
                <Link
                  href="/sell"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/sell")
                      ? "tab-active"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    <span>{network === "robinhood" ? "Sell" : "Reload SOL"}</span>
                  </div>
                </Link>
                ) : null}

                {can("/buy") ? (
                <Link
                  href="/buy"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/buy")
                      ? "tab-active"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                      />
                    </svg>
                    <span>Buy</span>
                  </div>
                </Link>
                ) : null}

                {can("/swap") ? (
                <Link
                  href="/swap"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/swap")
                      ? "tab-active"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                      />
                    </svg>
                    <span>Swap</span>
                  </div>
                </Link>
                ) : null}

                {can("/search-token") ? (
                <Link
                  href="/search-token"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/search-token")
                      ? "tab-active"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
                      />
                    </svg>
                    <span>Search</span>
                  </div>
                </Link>
                ) : null}

                {mounted && isDevUser && (
                  <>
                    {can("/dev/signals") ? (
                    <Link
                      href="/dev/signals"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/signals")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Signals"
                      aria-label="Signals"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/dev/algo-tester") ? (
                    <Link
                      href="/dev/algo-tester"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/algo-tester")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Algo Tester"
                      aria-label="Algo Tester"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/dev/dlmm") ? (
                    <Link
                      href="/dev/dlmm"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/dlmm")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="DLMM Agent"
                      aria-label="DLMM Agent"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 6h16M4 12h16M4 18h7"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/dev/social") ? (
                    <Link
                      href="/dev/social"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/social")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Social"
                      aria-label="Social"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/dev/strategies") ? (
                    <Link
                      href="/dev/strategies"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/strategies")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Strategy Admin"
                      aria-label="Strategy Admin"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/search-token") ? (
                    <Link
                      href="/search-token"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/search-token")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Search token"
                      aria-label="Search token"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                      </svg>
                    </Link>
                    ) : null}
                    {can("/dev/ohlc-labels") ? (
                    <Link
                      href="/dev/ohlc-labels"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/ohlc-labels")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="OHLC labels"
                    >
                      <span className="text-xs font-semibold">OHLC</span>
                    </Link>
                    ) : null}
                    {can("/dev/arbitrage") ? (
                    <Link
                      href="/dev/arbitrage"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/arbitrage")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="SOL arbitration"
                    >
                      <span className="text-xs font-semibold">Arb</span>
                    </Link>
                    ) : null}
                  </>
                )}
              </>
            )}

            {showPortfolioChrome ? (
            <div className="border-l border-gray-600 pl-2 ml-2 flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => handleTabClick("history")}
                className={`px-4 py-3 rounded-lg font-medium transition-all duration-200 ${
                  isActive("history")
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
                title="Trading History"
                aria-label="Trading History"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => handleTabClick("pnl")}
                className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                  isActive("pnl")
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
                title="P&L Tracker"
                aria-label="P&L Tracker"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
              </button>
            </div>
            ) : null}
          </ScrollableMenuRow>

          {/* Wallet Balance Display */}
          <div className="h-full shrink-0">
            {mounted && !isMobile ? (
              showSolChrome ? <WalletBalance /> : <RhWalletBalance />
            ) : null}
          </div>
        </div>
      </div>
      </div>

      {/* Mobile Top Bar - Balance & Info Tabs */}
      <div className="md:hidden max-w-4xl mx-auto mb-2 z-50 pt-2">
        <div className="flex items-center justify-between px-4 py-3 rounded-lg mb-4">
          <div className="flex-1">
            {mounted && isMobile ? (
              showSolChrome ? <WalletBalance /> : <RhWalletBalance />
            ) : null}
          </div>

          {showPortfolioChrome ? (
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => handleTabClick("history")}
              className={`p-2 rounded-lg transition-all duration-200 ${
                isActive("history")
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
              title="Trading History"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => handleTabClick("pnl")}
              className={`p-2 rounded-lg transition-all duration-200 ${
                isActive("pnl")
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
              title="P&L Tracker"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </button>
          </div>
          ) : null}
        </div>
      </div>

      {/* Mobile Navigation - Bottom Fixed */}
      {showMainTabs && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-9999">
          <ScrollableMenuRow className="py-3 px-2" innerClassName="gap-1 mx-auto" bleed={false}>
            {can("/sell") ? (
            <Link
              href="/sell"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/sell") ? "tab-active" : "text-gray-400"
              }`}
            >
              <svg
                className="w-6 h-6 mb-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span className="text-xs font-medium">
                {network === "robinhood" ? "Sell" : "Reload"}
              </span>
            </Link>
            ) : null}

            {can("/buy") ? (
            <Link
              href="/buy"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/buy") ? "tab-active" : "text-gray-400"
              }`}
            >
              <svg
                className="w-6 h-6 mb-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              <span className="text-xs font-medium">Buy</span>
            </Link>
            ) : null}

            {can("/swap") ? (
            <Link
              href="/swap"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/swap") ? "tab-active" : "text-gray-400"
              }`}
            >
              <svg
                className="w-6 h-6 mb-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                />
              </svg>
              <span className="text-xs font-medium">Swap</span>
            </Link>
            ) : null}

            {can("/search-token") ? (
            <Link
              href="/search-token"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/search-token") ? "tab-active" : "text-gray-400"
              }`}
            >
              <svg
                className="w-6 h-6 mb-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
                />
              </svg>
              <span className="text-xs font-medium">Search</span>
            </Link>
            ) : null}

            {mounted && isDevUser && (
              <>
                {can("/dev/signals") ? (
                <Link
                  href="/dev/signals"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/signals")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                  <span className="text-xs font-medium">Signals</span>
                </Link>
                ) : null}
                {can("/dev/algo-tester") ? (
                <Link
                  href="/dev/algo-tester"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/algo-tester")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                    />
                  </svg>
                  <span className="text-xs font-medium">Algo</span>
                </Link>
                ) : null}
                {can("/dev/dlmm") ? (
                <Link
                  href="/dev/dlmm"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/dlmm")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h7"
                    />
                  </svg>
                  <span className="text-xs font-medium">DLMM</span>
                </Link>
                ) : null}
                {can("/dev/social") ? (
                <Link
                  href="/dev/social"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/social")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                  <span className="text-xs font-medium">Social</span>
                </Link>
                ) : null}
                {can("/dev/strategies") ? (
                <Link
                  href="/dev/strategies"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/strategies")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  <span className="text-xs font-medium">Strategies</span>
                </Link>
                ) : null}
                {can("/dev/token-search") ? (
                <Link
                  href="/search-token"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/search-token")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <svg
                    className="w-6 h-6 mb-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
                    />
                  </svg>
                  <span className="text-xs font-medium">Search</span>
                </Link>
                ) : null}
                {can("/dev/ohlc-labels") ? (
                <Link
                  href="/dev/ohlc-labels"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/ohlc-labels")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <span className="mb-1 text-sm font-bold">OHLC</span>
                  <span className="text-xs font-medium">Labels</span>
                </Link>
                ) : null}
                {can("/dev/arbitrage") ? (
                <Link
                  href="/dev/arbitrage"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/arbitrage")
                      ? "bg-white text-black"
                      : "text-gray-400"
                  }`}
                >
                  <span className="mb-1 text-sm font-bold">Arb</span>
                  <span className="text-xs font-medium">Console</span>
                </Link>
                ) : null}
              </>
            )}
          </ScrollableMenuRow>
        </div>
      )}
    </div>
  );
}
