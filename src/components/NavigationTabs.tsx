"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ScrollableMenuRow from "@/components/ScrollableMenuRow";
import WalletBalance from "@/components/WalletBalance";
import { useDevWalletAccess } from "@/components/WalletProvider";
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
  const mounted = useIsClient();
  const isMobile = useIsMobile();

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
    "/dev/signals",
    "/dev/algo-tester",
    "/dev/dlmm",
    "/dev/social",
    "/dev/strategies",
    "/dev/token-search",
  ].some((path) => (pathname || "").startsWith(path));

  const handleTabClick = (tab: string) => {
    if (onTabSelect) {
      onTabSelect(activeOverlayTab === tab ? null : tab);
    }
  };

  return (
    <div className="w-full relative z-50">
      {/* Desktop Navigation */}
      <div
        className={`hidden md:block ${mounted && isDevUser ? "max-w-6xl" : "max-w-4xl"} mx-auto mb-2`}
      >
        <div className="flex items-center justify-between h-full mb-4 gap-4">
          <ScrollableMenuRow className="min-w-0 flex-1" innerClassName="gap-2" bleed={false}>
            {/* Main Trading Tabs */}
            {showMainTabs && (
              <>
                <Link
                  href="/sell"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/sell")
                      ? "bg-white text-black"
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
                    <span>Reload SOL</span>
                  </div>
                </Link>

                <Link
                  href="/buy"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/buy")
                      ? "bg-white text-black"
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

                <Link
                  href="/swap"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive("/swap")
                      ? "bg-white text-black"
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

                {mounted && isDevUser && (
                  <>
                    <Link
                      href="/dev/signals"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/signals")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Signals"
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
                    <Link
                      href="/dev/algo-tester"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/algo-tester")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Algo Tester"
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
                    <Link
                      href="/dev/dlmm"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/dlmm")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="DLMM Agent"
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
                    <Link
                      href="/dev/social"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/social")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Social"
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
                    <Link
                      href="/dev/strategies"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/strategies")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Strategy Admin"
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
                    <Link
                      href="/dev/token-search"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/token-search")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Token map"
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
                  </>
                )}
              </>
            )}

            {/* Info Tabs */}
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
          </ScrollableMenuRow>

          {/* Wallet Balance Display */}
          <div className="h-full shrink-0">
            {mounted && !isMobile && <WalletBalance />}
          </div>
        </div>
      </div>

      {/* Mobile Top Bar - SOL Balance & Info Tabs */}
      <div className="md:hidden max-w-4xl mx-auto mb-2 z-50 pt-2">
        <div className="flex items-center justify-between px-4 py-3 rounded-lg mb-4">
          {/* SOL Balance on Left */}
          <div className="flex-1">
            {mounted && isMobile && <WalletBalance />}
          </div>

          {/* History & P&L on Right */}
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
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Navigation - Bottom Fixed */}
      {showMainTabs && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-9999">
          <ScrollableMenuRow className="py-3 px-2" innerClassName="gap-1 mx-auto" bleed={false}>
            {/* Main Trading Tabs Only */}
            <Link
              href="/sell"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/sell") ? "bg-white text-black" : "text-gray-400"
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
              <span className="text-xs font-medium">Reload</span>
            </Link>

            <Link
              href="/buy"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/buy") ? "bg-white text-black" : "text-gray-400"
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

            <Link
              href="/swap"
              className={`flex shrink-0 flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive("/swap") ? "bg-white text-black" : "text-gray-400"
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

            {mounted && isDevUser && (
              <>
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
                <Link
                  href="/dev/token-search"
                  className={`flex shrink-0 flex-col items-center px-3 py-2 rounded-lg transition-all duration-200 ${
                    isActive("/dev/token-search")
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
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <span className="text-xs font-medium">Locate</span>
                </Link>
              </>
            )}
          </ScrollableMenuRow>
        </div>
      )}
    </div>
  );
}
