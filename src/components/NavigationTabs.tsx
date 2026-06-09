"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import WalletBalance from "@/components/WalletBalance";
import { useDevWalletAccess } from "@/components/WalletProvider";

export default function NavigationTabs({
  activeOverlayTab,
  onTabSelect,
}: {
  activeOverlayTab?: string | null;
  onTabSelect?: (tab: string | null) => void;
}) {
  const pathname = usePathname();
  const isDevUser = useDevWalletAccess();
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    setMounted(true);
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

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
    "/catch-the-coin",
    "/charts",
    "/dev/signals",
    "/dev/trending-tracker",
    "/dev/tracking-history",
    "/dev/mcap-tracker",
    "/dev/pools",
    "/dev/pools-test",
    "/dev/dlmm",
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
        <div className="flex items-center justify-between h-full mb-4">
          <div className="flex items-center space-x-2">
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

                {mounted && isDevUser && (
                  <>
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
                    <Link
                      href="/catch-the-coin"
                      className={`px-3 py-3 ml-1 rounded-lg font-semibold transition-all duration-200 ${
                        isActive("/catch-the-coin")
                          ? "bg-white text-black"
                          : "text-gray-400 hover:text-white hover:bg-gray-700"
                      }`}
                      title="Catch The Coin"
                    >
                      <div className="flex items-center justify-center">
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
                            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </div>
                    </Link>
                    <Link
                      href="/charts"
                      className={`px-3 py-3 ml-1 rounded-lg font-semibold transition-all duration-200 ${
                        isActive("/charts")
                          ? "bg-white text-black"
                          : "text-gray-400 hover:text-white hover:bg-gray-700"
                      }`}
                      title="Charts (Kanban)"
                    >
                      <div className="flex items-center justify-center">
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
                            d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                          />
                        </svg>
                      </div>
                    </Link>
                    <Link
                      href="/dev/signals"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/signals")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Trading Signals"
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
                      href="/dev/trending-tracker"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/trending-tracker")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Trending Tracker (Dev)"
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
                      href="/dev/tracking-history"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/tracking-history")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="Tracking History (Dev)"
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
                          d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
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
                      title="DLMM Agent (Dev)"
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
                      href="/dev/mcap-tracker"
                      className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                        isActive("/dev/mcap-tracker")
                          ? "bg-gray-700 text-white"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                      title="MCap Tracker (Dev)"
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
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 2v6m0 0v6m0-6h6m-6 0H6"
                          opacity="0.5"
                        />
                      </svg>
                    </Link>
                  </>
                )}
              </>
            )}

            {/* Info Tabs */}
            <div className="border-l border-gray-600 pl-2 ml-2 flex items-center">
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
              {mounted && isDevUser && (
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
              )}
            </div>
          </div>

          {/* Wallet Balance Display */}
          <div className="h-full">
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
            {mounted && isDevUser && (
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
            )}
          </div>
        </div>
      </div>

      {/* Mobile Navigation - Bottom Fixed */}
      {showMainTabs && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-9999">
          <div className="flex items-center justify-around px-2 py-3">
            {/* Main Trading Tabs Only */}
            <Link
              href="/sell"
              className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
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
              className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
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

            {mounted && isDevUser && (
              <Link
                href="/swap"
                className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
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
            )}
            {mounted && isDevUser && (
              <Link
                href="/charts"
                className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                  isActive("/charts") ? "bg-white text-black" : "text-gray-400"
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
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                  />
                </svg>
                <span className="text-xs font-medium">Charts</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
