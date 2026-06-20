"use client";

import React, { useState, useCallback } from "react";
import TokenSearchInterface from "@/components/TokenSearchInterface";
import {
  usePoolsTest,
  type PoolTestResult,
  type ComprehensiveTestResults,
  type StressTestResults,
  type BenchmarkTestResults,
  type TestResults,
  type TestType,
} from "@/hooks/usePoolsTest";
import { useQueryClient } from "@tanstack/react-query";

// Skeleton loader component
const TestSkeleton = () => (
  <div className="space-y-6 animate-pulse">
    {/* Header skeleton */}
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="h-6 bg-gray-700 rounded w-1/3 mb-4"></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="h-20 bg-gray-700 rounded"></div>
        <div className="h-20 bg-gray-700 rounded"></div>
        <div className="h-20 bg-gray-700 rounded"></div>
      </div>
    </div>

    {/* Stats skeleton */}
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-gray-800 p-6 rounded-lg">
          <div className="h-5 bg-gray-700 rounded w-2/3 mb-3"></div>
          <div className="h-8 bg-gray-700 rounded w-1/2 mb-2"></div>
          <div className="h-4 bg-gray-700 rounded w-3/4"></div>
        </div>
      ))}
    </div>

    {/* Content skeleton */}
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="h-6 bg-gray-700 rounded w-1/4 mb-4"></div>
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-gray-700 rounded-lg p-4">
            <div className="h-5 bg-gray-600 rounded w-1/3 mb-3"></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="h-24 bg-gray-600 rounded"></div>
              <div className="h-24 bg-gray-600 rounded"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default function PoolsTestPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [testType, setTestType] = useState<TestType>("comprehensive");
  const [authError, setAuthError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const {
    data: testResults,
    isFetching: loading,
    error: queryError,
    refetch,
  } = usePoolsTest({ testType });

  const error =
    (queryError instanceof Error ? queryError.message : null) || authError;

  const handleAuth = useCallback(() => {
    // Simple password check - in production, use proper authentication
    if (password === "reloadsol" || password === "jupiter-test") {
      setIsAuthenticated(true);
      setPassword("");
      setAuthError(null);
    } else {
      setAuthError("Invalid password. Hint: dev2025 or jupiter-test");
    }
  }, [password]);

  const runPoolsTest = useCallback(() => {
    console.log(`🚀 Starting ${testType} test...`);
    setAuthError(null);
    refetch();
  }, [refetch, testType]);

  const handleClear = useCallback(() => {
    queryClient.resetQueries({ queryKey: ["pools-test"] });
    setAuthError(null);
  }, [queryClient]);

  const getProviderIcon = (provider: string): string => {
    switch (provider) {
      case "jupiter":
        return "🪐";
      case "dflow":
        return "🌊";
      case "solana-tracker":
        return "📊";
      default:
        return "❓";
    }
  };

  const formatAmount = (amount: string, decimals: number = 6): string => {
    const num = parseFloat(amount);
    return num.toFixed(decimals);
  };

  // Helper function for age badge colors
  const getAgeBadgeColor = (category: string): string => {
    switch (category) {
      case "NEW":
        return "bg-green-600 text-green-100 border-green-500";
      case "RECENT":
        return "bg-blue-600 text-blue-100 border-blue-500";
      case "ESTABLISHED":
        return "bg-yellow-600 text-yellow-100 border-yellow-500";
      case "OLD":
        return "bg-gray-600 text-gray-100 border-gray-500";
      default:
        return "bg-gray-600 text-gray-100 border-gray-500";
    }
  };

  // Helper function to format numbers
  const formatNumber = (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(2)}K`;
    }
    return num.toLocaleString();
  };

  // Type guards
  const isComprehensiveResult = (
    result: TestResults,
  ): result is ComprehensiveTestResults => {
    return !("testType" in result) || result.testType === "comprehensive";
  };

  const isStressResult = (result: TestResults): result is StressTestResults => {
    return "testType" in result && result.testType === "stress";
  };

  const isBenchmarkResult = (
    result: TestResults,
  ): result is BenchmarkTestResults => {
    return "testType" in result && result.testType === "benchmark";
  };

  const getFastestProvider = () => {
    if (!testResults || !isComprehensiveResult(testResults)) return null;
    const providers = Object.entries(testResults.summary.providerPerformance);
    return providers.reduce((fastest, [provider, stats]) =>
      stats.avgResponseTime < fastest[1].avgResponseTime
        ? [provider, stats]
        : fastest,
    );
  };

  const getBestRateProvider = () => {
    if (!testResults || !isComprehensiveResult(testResults)) return null;
    const providers = Object.entries(testResults.summary.providerPerformance);
    return providers.reduce((best, [provider, stats]) =>
      stats.successes > best[1].successes ? [provider, stats] : best,
    );
  };

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="max-w-md mx-auto">
            <div className="bg-white p-8 rounded-lg shadow-lg">
              <h1 className="text-2xl font-bold mb-6 text-center text-red-600">
                🔒 Developer Access Required
              </h1>
              <p className="text-gray-600 mb-4 text-center">
                This page is restricted to developers only. Please enter the
                access password.
              </p>
              <div className="space-y-4">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => e.key === "Enter" && handleAuth()}
                  placeholder="Enter developer password"
                  className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleAuth}
                  className="w-full bg-blue-600 text-white py-3 px-6 rounded-md hover:bg-blue-700 transition-colors"
                >
                  Access Dev Tools
                </button>
                {error && (
                  <div className="p-3 bg-red-100 border border-red-300 rounded-md text-red-700 text-sm">
                    {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black py-8 relative">
      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-white mb-4">
              🧪 Jupiter Pools Test Lab
            </h1>
            <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Developer-only testing interface for trade providers
            </h2>
            <div className="mt-6">
              <button
                onClick={() => setIsAuthenticated(false)}
                className="bg-red-500 text-white px-6 py-3 rounded-lg hover:bg-red-600 transition-colors font-semibold"
              >
                Logout
              </button>
            </div>
          </div>

          {/* Test Controls */}
          <div className="bg-black border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4 text-white">
              Test Configuration
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Test Type
                </label>
                <select
                  value={testType}
                  onChange={(e) => setTestType(e.target.value as any)}
                  className="w-full p-3 bg-gray-800 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                >
                  <option value="comprehensive">
                    Comprehensive (5 pools, buy/sell)
                  </option>
                  <option value="stress">
                    Stress Test (concurrent requests)
                  </option>
                  <option value="benchmark">
                    Quick Benchmark (speed test)
                  </option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={runPoolsTest}
                  disabled={loading}
                  className="w-full bg-blue-600 text-white py-3 px-6 rounded-md hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "🔄 Testing..." : "🚀 Run Test"}
                </button>
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleClear}
                  className="w-full bg-gray-600 text-white py-3 px-6 rounded-md hover:bg-gray-700 transition-colors"
                >
                  🗑️ Clear Results
                </button>
              </div>
            </div>

            {error && (
              <div className="p-4 bg-yellow-900 border border-yellow-700 rounded-md">
                <p className="text-yellow-200">{error}</p>
              </div>
            )}
          </div>

          {/* Loading skeleton */}
          {loading && <TestSkeleton />}

          {/* Quick Stats - Comprehensive Test Only */}
          {testResults && isComprehensiveResult(testResults) && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-green-900 p-6 rounded-lg border border-green-700">
                <h3 className="text-lg font-bold text-green-200 mb-2">
                  🏆 Fastest Provider
                </h3>
                {(() => {
                  const fastest = getFastestProvider();
                  return fastest ? (
                    <div>
                      <p className="text-2xl font-bold text-green-300">
                        {getProviderIcon(fastest[0])} {fastest[0]}
                      </p>
                      <p className="text-sm text-green-400">
                        {Math.round(fastest[1].avgResponseTime)}ms avg
                      </p>
                    </div>
                  ) : (
                    <p className="text-gray-400">No data</p>
                  );
                })()}
              </div>

              <div className="bg-blue-900 p-6 rounded-lg border border-blue-700">
                <h3 className="text-lg font-bold text-blue-200 mb-2">
                  💰 Best Rate Provider
                </h3>
                {(() => {
                  const bestRate = getBestRateProvider();
                  return bestRate ? (
                    <div>
                      <p className="text-2xl font-bold text-blue-300">
                        {getProviderIcon(bestRate[0])} {bestRate[0]}
                      </p>
                      <p className="text-sm text-blue-400">
                        {bestRate[1].successes} successes
                      </p>
                    </div>
                  ) : (
                    <p className="text-gray-400">No data</p>
                  );
                })()}
              </div>

              <div className="bg-purple-900 p-6 rounded-lg border border-purple-700">
                <h3 className="text-lg font-bold text-purple-200 mb-2">
                  📊 Success Rate
                </h3>
                <p className="text-2xl font-bold text-purple-300">
                  {testResults.summary.successfulBuyTests +
                    testResults.summary.successfulSellTests}
                  /{testResults.summary.totalPools * 2}
                </p>
                <p className="text-sm text-purple-400">
                  {Math.round(
                    ((testResults.summary.successfulBuyTests +
                      testResults.summary.successfulSellTests) /
                      (testResults.summary.totalPools * 2)) *
                      100,
                  )}
                  % overall
                </p>
              </div>

              <div className="bg-orange-900 p-6 rounded-lg border border-orange-700">
                <h3 className="text-lg font-bold text-orange-200 mb-2">
                  ⚡ Avg Response
                </h3>
                <p className="text-2xl font-bold text-orange-300">
                  {testResults.summary.averageResponseTime}ms
                </p>
                <p className="text-sm text-orange-400">All providers</p>
              </div>
            </div>
          )}

          {/* Quick Stats - Stress Test */}
          {testResults && isStressResult(testResults) && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-red-900 p-6 rounded-lg border border-red-700">
                <h3 className="text-lg font-bold text-red-200 mb-2">
                  🔥 Total Requests
                </h3>
                <p className="text-2xl font-bold text-red-300">
                  {testResults.summary.totalRequests}
                </p>
                <p className="text-sm text-red-400">
                  {testResults.summary.concurrentRequests} concurrent
                </p>
              </div>

              <div className="bg-green-900 p-6 rounded-lg border border-green-700">
                <h3 className="text-lg font-bold text-green-200 mb-2">
                  ✅ Success Rate
                </h3>
                <p className="text-2xl font-bold text-green-300">
                  {Math.round(
                    (testResults.summary.successfulRequests /
                      testResults.summary.totalRequests) *
                      100,
                  )}
                  %
                </p>
                <p className="text-sm text-green-400">
                  {testResults.summary.successfulRequests}/
                  {testResults.summary.totalRequests}
                </p>
              </div>

              <div className="bg-purple-900 p-6 rounded-lg border border-purple-700">
                <h3 className="text-lg font-bold text-purple-200 mb-2">
                  📊 Pools Tested
                </h3>
                <p className="text-2xl font-bold text-purple-300">
                  {testResults.summary.totalPools}
                </p>
                <p className="text-sm text-purple-400">pools</p>
              </div>

              <div className="bg-orange-900 p-6 rounded-lg border border-orange-700">
                <h3 className="text-lg font-bold text-orange-200 mb-2">
                  ⚡ Avg Response
                </h3>
                <p className="text-2xl font-bold text-orange-300">
                  {testResults.summary.averageResponseTime}ms
                </p>
                <p className="text-sm text-orange-400">All requests</p>
              </div>
            </div>
          )}

          {/* Quick Stats - Benchmark Test */}
          {testResults && isBenchmarkResult(testResults) && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-blue-900 p-6 rounded-lg border border-blue-700">
                <h3 className="text-lg font-bold text-blue-200 mb-2">
                  🎯 Test Pool
                </h3>
                <p className="text-2xl font-bold text-blue-300">
                  {testResults.summary.testPool}
                </p>
                <p className="text-sm text-blue-400">token tested</p>
              </div>

              <div className="bg-green-900 p-6 rounded-lg border border-green-700">
                <h3 className="text-lg font-bold text-green-200 mb-2">
                  🏆 Fastest Provider
                </h3>
                <p className="text-2xl font-bold text-green-300">
                  {getProviderIcon(testResults.summary.fastestProvider)}{" "}
                  {testResults.summary.fastestProvider}
                </p>
                <p className="text-sm text-green-400">winner</p>
              </div>

              <div className="bg-purple-900 p-6 rounded-lg border border-purple-700">
                <h3 className="text-lg font-bold text-purple-200 mb-2">
                  📊 Iterations
                </h3>
                <p className="text-2xl font-bold text-purple-300">
                  {testResults.summary.totalIterations}
                </p>
                <p className="text-sm text-purple-400">completed</p>
              </div>

              <div className="bg-orange-900 p-6 rounded-lg border border-orange-700">
                <h3 className="text-lg font-bold text-orange-200 mb-2">
                  ⚡ Avg Response
                </h3>
                <p className="text-2xl font-bold text-orange-300">
                  {testResults.summary.averageResponseTime}ms
                </p>
                <p className="text-sm text-orange-400">All providers</p>
              </div>
            </div>
          )}

          {/* Price Analysis - Comprehensive Test Only */}
          {testResults && isComprehensiveResult(testResults) && (
            <div className="bg-black border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4 text-white">
                📈 Price Analysis
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Buy Analysis */}
                <div className="bg-green-900 border border-green-700 rounded-lg p-4">
                  <h3 className="text-lg font-bold text-green-200 mb-3">
                    🟢 Buy Operations
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-green-300">Avg Price Spread:</span>
                      <span className="font-bold text-white">
                        {testResults.summary.priceAnalysis.avgBuyPriceSpread}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-green-300">Avg Price Impact:</span>
                      <span className="font-bold text-white">
                        {testResults.summary.priceAnalysis.avgBuyPriceImpact}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-green-300">Best Provider:</span>
                      <span className="font-bold text-green-200">
                        {getProviderIcon(
                          testResults.summary.priceAnalysis.bestBuyProvider,
                        )}{" "}
                        {testResults.summary.priceAnalysis.bestBuyProvider}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Sell Analysis */}
                <div className="bg-red-900 border border-red-700 rounded-lg p-4">
                  <h3 className="text-lg font-bold text-red-200 mb-3">
                    🔴 Sell Operations
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-red-300">Avg Price Spread:</span>
                      <span className="font-bold text-white">
                        {testResults.summary.priceAnalysis.avgSellPriceSpread}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-red-300">Avg Price Impact:</span>
                      <span className="font-bold text-white">
                        {testResults.summary.priceAnalysis.avgSellPriceImpact}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-red-300">Best Provider:</span>
                      <span className="font-bold text-red-200">
                        {getProviderIcon(
                          testResults.summary.priceAnalysis.bestSellProvider,
                        )}{" "}
                        {testResults.summary.priceAnalysis.bestSellProvider}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Overall Analysis */}
                <div className="bg-purple-900 border border-purple-700 rounded-lg p-4">
                  <h3 className="text-lg font-bold text-purple-200 mb-3">
                    📊 Overall
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-purple-300">Price Efficiency:</span>
                      <span className="font-bold text-white">
                        {testResults.summary.priceAnalysis.bestBuyProvider ===
                        testResults.summary.priceAnalysis.bestSellProvider
                          ? "Consistent"
                          : "Varied"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-purple-300">Market Depth:</span>
                      <span className="font-bold text-white">
                        {parseFloat(
                          testResults.summary.priceAnalysis.avgBuyPriceSpread.replace(
                            "%",
                            "",
                          ),
                        ) < 5
                          ? "Deep"
                          : "Shallow"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-purple-300">Liquidity:</span>
                      <span className="font-bold text-white">
                        {parseFloat(
                          testResults.summary.priceAnalysis.avgBuyPriceImpact.replace(
                            "%",
                            "",
                          ),
                        ) < 1
                          ? "High"
                          : "Medium"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Provider Performance - Comprehensive Test Only */}
          {testResults && isComprehensiveResult(testResults) && (
            <div className="bg-black border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4 text-white">
                🏆 Provider Performance
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(testResults.summary.providerPerformance).map(
                  ([provider, stats]) => (
                    <div
                      key={provider}
                      className="border border-gray-600 bg-gray-900 rounded-lg p-4"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold flex items-center gap-2 text-white">
                          {getProviderIcon(provider)} {provider}
                        </h3>
                        <div
                          className={`px-2 py-1 rounded-full text-xs font-bold ${
                            testResults.providerHealth[provider]
                              ? "bg-green-700 text-green-200"
                              : "bg-red-700 text-red-200"
                          }`}
                        >
                          {testResults.providerHealth[provider]
                            ? "HEALTHY"
                            : "DOWN"}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-400">
                            Success Rate:
                          </span>
                          <span className="font-bold text-white">
                            {Math.round(
                              (stats.successes /
                                (stats.successes + stats.failures)) *
                                100,
                            )}
                            %
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-400">
                            Avg Response:
                          </span>
                          <span className="font-bold text-white">
                            {Math.round(stats.avgResponseTime)}ms
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-400">
                            Successes:
                          </span>
                          <span className="font-bold text-green-400">
                            {stats.successes}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-400">
                            Failures:
                          </span>
                          <span className="font-bold text-red-400">
                            {stats.failures}
                          </span>
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          {/* Pool Results - Comprehensive Test Only */}
          {testResults && isComprehensiveResult(testResults) && (
            <div className="bg-black border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4 text-white">
                Pool Test Results
              </h2>
              <div className="space-y-4">
                {testResults.results.map((pool, index) => (
                  <div
                    key={pool.poolId}
                    className="border border-gray-600 bg-gray-900 rounded-lg p-4"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-lg font-bold text-white">
                            {pool.symbol}
                          </h3>
                          <div
                            className={`px-3 py-1 rounded-full text-xs font-bold border ${getAgeBadgeColor(pool.tokenAge.ageCategory)}`}
                          >
                            🕐 {pool.tokenAge.ageDisplay}
                          </div>
                        </div>
                        <p className="text-sm text-gray-400 font-mono mb-1">
                          {pool.poolId}
                        </p>
                        <div className="flex gap-4 text-sm">
                          <span className="text-gray-500">
                            💧 Liquidity:{" "}
                            {pool.liquidity
                              ? `$${formatNumber(pool.liquidity)}`
                              : "Unknown"}
                          </span>
                          {pool.marketCap && (
                            <span className="text-gray-500">
                              📊 Market Cap: ${formatNumber(pool.marketCap)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 mt-1">
                          Created:{" "}
                          {new Date(
                            pool.tokenAge.createdAt,
                          ).toLocaleDateString()}{" "}
                          ({pool.tokenAge.ageInDays} days ago)
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Buy Test */}
                      <div
                        className={`p-4 rounded-lg border-2 ${
                          pool.buyTest.success
                            ? "bg-green-900 border-green-600"
                            : "bg-red-900 border-red-600"
                        }`}
                      >
                        <h4 className="font-bold text-lg mb-3 text-white">
                          🟢 BUY Test {pool.buyTest.success ? "✅" : "❌"}
                        </h4>

                        {pool.buyTest.success &&
                        pool.buyTest.priceComparison ? (
                          <div className="space-y-3 text-white">
                            {/* Best Price Summary */}
                            <div className="bg-green-800 p-3 rounded">
                              <p className="text-sm text-green-200">
                                🏆 Best Price
                              </p>
                              <p>
                                <strong>Provider:</strong>{" "}
                                {getProviderIcon(
                                  pool.buyTest.priceComparison.bestPrice
                                    .provider,
                                )}{" "}
                                {
                                  pool.buyTest.priceComparison.bestPrice
                                    .provider
                                }
                              </p>
                              <p>
                                <strong>Amount:</strong>{" "}
                                {formatAmount(
                                  pool.buyTest.priceComparison.bestPrice
                                    .outputAmount,
                                )}{" "}
                                tokens
                              </p>
                              <p>
                                <strong>Advantage:</strong>{" "}
                                <span className="text-green-300">
                                  {
                                    pool.buyTest.priceComparison.bestPrice
                                      .advantage
                                  }
                                </span>
                              </p>
                            </div>

                            {/* Price Metrics */}
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div className="bg-gray-800 p-2 rounded">
                                <p className="text-gray-400">Price Spread</p>
                                <p className="font-bold">
                                  {pool.buyTest.priceComparison.priceSpread}
                                </p>
                              </div>
                              <div className="bg-gray-800 p-2 rounded">
                                <p className="text-gray-400">Avg Impact</p>
                                <p className="font-bold">
                                  {pool.buyTest.priceComparison.avgPriceImpact}
                                </p>
                              </div>
                            </div>

                            {/* Provider Details */}
                            <div className="space-y-2">
                              <p className="text-sm font-bold text-green-200">
                                Provider Breakdown:
                              </p>
                              {Object.entries(
                                pool.buyTest.priceComparison.providers,
                              ).map(([provider, data]) => (
                                <div
                                  key={provider}
                                  className={`p-2 rounded text-xs ${
                                    data.success ? "bg-green-800" : "bg-red-800"
                                  }`}
                                >
                                  <div className="flex justify-between items-center">
                                    <span className="font-bold">
                                      {getProviderIcon(provider)} {provider}
                                    </span>
                                    <span
                                      className={
                                        data.success
                                          ? "text-green-200"
                                          : "text-red-200"
                                      }
                                    >
                                      {data.success ? "✅" : "❌"}
                                    </span>
                                  </div>
                                  {data.success && (
                                    <div className="mt-1 space-y-1">
                                      <div className="flex justify-between">
                                        <span>Amount:</span>
                                        <span>
                                          {formatAmount(data.outputAmount)}{" "}
                                          tokens
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Impact:</span>
                                        <span>{data.priceImpact}%</span>
                                      </div>
                                      {data.fee && (
                                        <div className="flex justify-between">
                                          <span>Fee:</span>
                                          <span>
                                            {data.fee.feePercentage.toFixed(3)}%
                                          </span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span>Speed:</span>
                                        <span>{data.responseTime}ms</span>
                                      </div>
                                    </div>
                                  )}
                                  {!data.success && data.error && (
                                    <p className="text-red-300 text-xs mt-1">
                                      {data.error}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-red-300">Test failed</p>
                        )}
                      </div>

                      {/* Sell Test */}
                      <div
                        className={`p-4 rounded-lg border-2 ${
                          pool.sellTest.success
                            ? "bg-green-900 border-green-600"
                            : "bg-red-900 border-red-600"
                        }`}
                      >
                        <h4 className="font-bold text-lg mb-3 text-white">
                          🔴 SELL Test {pool.sellTest.success ? "✅" : "❌"}
                        </h4>

                        {pool.sellTest.success &&
                        pool.sellTest.priceComparison ? (
                          <div className="space-y-3 text-white">
                            {/* Best Price Summary */}
                            <div className="bg-green-800 p-3 rounded">
                              <p className="text-sm text-green-200">
                                🏆 Best Price
                              </p>
                              <p>
                                <strong>Provider:</strong>{" "}
                                {getProviderIcon(
                                  pool.sellTest.priceComparison.bestPrice
                                    .provider,
                                )}{" "}
                                {
                                  pool.sellTest.priceComparison.bestPrice
                                    .provider
                                }
                              </p>
                              <p>
                                <strong>Amount:</strong>{" "}
                                {
                                  pool.sellTest.priceComparison.bestPrice
                                    .outputAmount
                                }{" "}
                                lamports
                              </p>
                              <p>
                                <strong>Advantage:</strong>{" "}
                                <span className="text-green-300">
                                  {
                                    pool.sellTest.priceComparison.bestPrice
                                      .advantage
                                  }
                                </span>
                              </p>
                            </div>

                            {/* Price Metrics */}
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div className="bg-gray-800 p-2 rounded">
                                <p className="text-gray-400">Price Spread</p>
                                <p className="font-bold">
                                  {pool.sellTest.priceComparison.priceSpread}
                                </p>
                              </div>
                              <div className="bg-gray-800 p-2 rounded">
                                <p className="text-gray-400">Avg Impact</p>
                                <p className="font-bold">
                                  {pool.sellTest.priceComparison.avgPriceImpact}
                                </p>
                              </div>
                            </div>

                            {/* Provider Details */}
                            <div className="space-y-2">
                              <p className="text-sm font-bold text-green-200">
                                Provider Breakdown:
                              </p>
                              {Object.entries(
                                pool.sellTest.priceComparison.providers,
                              ).map(([provider, data]) => (
                                <div
                                  key={provider}
                                  className={`p-2 rounded text-xs ${
                                    data.success ? "bg-green-800" : "bg-red-800"
                                  }`}
                                >
                                  <div className="flex justify-between items-center">
                                    <span className="font-bold">
                                      {getProviderIcon(provider)} {provider}
                                    </span>
                                    <span
                                      className={
                                        data.success
                                          ? "text-green-200"
                                          : "text-red-200"
                                      }
                                    >
                                      {data.success ? "✅" : "❌"}
                                    </span>
                                  </div>
                                  {data.success && (
                                    <div className="mt-1 space-y-1">
                                      <div className="flex justify-between">
                                        <span>Amount:</span>
                                        <span>
                                          {data.outputAmount} lamports
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Impact:</span>
                                        <span>{data.priceImpact}%</span>
                                      </div>
                                      {data.fee && (
                                        <div className="flex justify-between">
                                          <span>Fee:</span>
                                          <span>
                                            {data.fee.feePercentage.toFixed(3)}%
                                          </span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span>Speed:</span>
                                        <span>{data.responseTime}ms</span>
                                      </div>
                                    </div>
                                  )}
                                  {!data.success && data.error && (
                                    <p className="text-red-300 text-xs mt-1">
                                      {data.error}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-red-300">Test failed</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw Data */}
          {testResults && (
            <div className="bg-black border border-gray-700 rounded-lg p-6">
              <details className="cursor-pointer">
                <summary className="font-medium text-gray-300 hover:text-white">
                  🔍 Raw Test Data (JSON)
                </summary>
                <pre className="mt-4 text-xs bg-gray-900 text-gray-300 p-4 rounded border border-gray-600 overflow-auto max-h-96">
                  {JSON.stringify(testResults, null, 2)}
                </pre>
              </details>
            </div>
          )}

          {/* Token Search Interface */}
          <TokenSearchInterface />

          {/* Test Results Section Separator */}
          {testResults && (
            <div className="border-t border-gray-700 pt-6">
              <h2 className="text-xl font-bold mb-4 text-white">
                🧪 Test Results
              </h2>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
