"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useWallet, useConnection } from "@/components/WalletProvider";
import PhantomWalletButton from "@/components/PhantomWalletButton";
import { useRpc } from "@/contexts/RpcContext";
import {
  categorizeUserTokens,
  fetchUserTokensEfficient,
} from "@/utils/jupiter";
import {
  fetchJupiterPortfolio,
  mapPortfolioToUserTokens,
} from "@/utils/jupiter-portfolio";
import {
  fetchShyftAllTokens,
  mapShyftTokensToUserTokens,
} from "@/utils/shyft-wallet";
import { TOKENS } from "@/utils/solana";

type FilterStage = {
  label: string;
  count: number;
  lost: number;
};

export default function RpcTesterPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [showDustOnly, setShowDustOnly] = useState(false);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineStages, setPipelineStages] = useState<FilterStage[]>([]);

  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const {
    endpoints,
    selectedEndpointIndex,
    diagnostics,
    isRunningDiagnostics,
    runDiagnostics,
    setSelectedEndpointIndex,
    autoSelectBest,
    setAutoSelectBest,
  } = useRpc();

  const handleAuth = useCallback(() => {
    if (password === "reloadsol" || password === "jupiter-test") {
      setIsAuthenticated(true);
      setPassword("");
      setAuthError(null);
    } else {
      setAuthError("Invalid password");
    }
  }, [password]);

  const runPipelineBreakdown = useCallback(async () => {
    if (!publicKey || !connection) return;
    setPipelineLoading(true);
    setPipelineError(null);
    try {
      const allTokens = await fetchUserTokensEfficient(
        connection,
        publicKey,
        true,
        false,
        undefined,
        true,
      );
      const { valuable, dust, zeroValue, sellable, zeroBalance, frozen, nfts } =
        categorizeUserTokens(allTokens);
      const closeOnly = [...zeroValue, ...zeroBalance, ...frozen];
      const dustTokenList = [...dust, ...zeroValue];
      const dustFiltered = showDustOnly ? dustTokenList : valuable;

      let shyftSplCount = 0;
      try {
        const shyft = await fetchShyftAllTokens(publicKey.toString());
        shyftSplCount = mapShyftTokensToUserTokens(shyft.tokens).length;
      } catch (shyftError) {
        console.warn("Shyft all_tokens fetch failed in pipeline:", shyftError);
      }

      let jupiterSplCount = 0;
      try {
        const portfolio = await fetchJupiterPortfolio(publicKey.toString());
        jupiterSplCount = mapPortfolioToUserTokens(portfolio).length;
      } catch (portfolioError) {
        console.warn("Jupiter portfolio fetch failed in pipeline:", portfolioError);
      }

      let raptorQuoteOk = 0;
      const sampleToken = dust[0] ?? valuable[0];
      if (sampleToken && sampleToken.balance > 0) {
        try {
          const params = new URLSearchParams({
            inputMint: sampleToken.mintAddress,
            outputMint: TOKENS.SOL,
            amount: String(Math.max(1, Math.floor(sampleToken.balance * 0.01))),
            slippageBps: "200",
          });
          const response = await fetch(
            `/api/solanatracker/quote?${params.toString()}`,
          );
          if (response.ok) {
            const data = await response.json();
            if (data.amountOut) raptorQuoteOk = 1;
          }
        } catch (raptorError) {
          console.warn("Raptor quote fetch failed in pipeline:", raptorError);
        }
      }

      const rpcRow = diagnostics.find((d) => d.index === selectedEndpointIndex);
      const rawRpcCount = rpcRow?.rawAccountCount ?? allTokens.length;

      setPipelineStages([
        {
          label: "Shyft all_tokens (SPL)",
          count: shyftSplCount,
          lost: Math.max(0, allTokens.length - shyftSplCount),
        },
        {
          label: "Jupiter portfolio (SPL)",
          count: jupiterSplCount,
          lost: Math.max(0, allTokens.length - jupiterSplCount),
        },
        {
          label: "Raptor quote (sample SPL→SOL)",
          count: raptorQuoteOk,
          lost: sampleToken ? Math.max(0, 1 - raptorQuoteOk) : 0,
        },
        {
          label: "RPC token accounts",
          count: rawRpcCount,
          lost: 0,
        },
        {
          label: "After jupiter processing",
          count: allTokens.length,
          lost: Math.max(0, rawRpcCount - allTokens.length),
        },
        {
          label: "Valuable bucket (>= $1)",
          count: valuable.length,
          lost: 0,
        },
        {
          label: "Dust bucket ($0.001 – $1)",
          count: dust.length,
          lost: 0,
        },
        {
          label: "Zero-value bucket (< $0.001)",
          count: zeroValue.length,
          lost: 0,
        },
        {
          label: "Close-only bucket",
          count: closeOnly.length,
          lost: 0,
        },
        {
          label: showDustOnly
            ? "After dust filter (< $1.00)"
            : "Visible sell list (valuable)",
          count: dustFiltered.length,
          lost: showDustOnly
            ? Math.max(0, valuable.length)
            : Math.max(0, dustTokenList.length),
        },
        {
          label: "Swappable (sellable alias)",
          count: sellable.length,
          lost: 0,
        },
      ]);
    } catch (error) {
      setPipelineError(
        error instanceof Error ? error.message : "Pipeline test failed",
      );
    } finally {
      setPipelineLoading(false);
    }
  }, [
    connection,
    publicKey,
    diagnostics,
    selectedEndpointIndex,
    showDustOnly,
  ]);

  const bestDiagnostic = useMemo(() => {
    return [...diagnostics]
      .filter((d) => d.indexHealthy)
      .sort((a, b) => {
        if (b.rawAccountCount !== a.rawAccountCount) {
          return b.rawAccountCount - a.rawAccountCount;
        }
        return a.getParsedTokenAccountsMs - b.getParsedTokenAccountsMs;
      })[0];
  }, [diagnostics]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-md mx-auto mt-20 p-8 bg-gray-900 border border-gray-700 rounded-2xl">
        <h1 className="text-2xl font-bold text-white mb-4">RPC Tester</h1>
        <p className="text-gray-400 mb-4 text-sm">Dev access required.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAuth()}
          className="w-full mb-3 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white"
          placeholder="Password"
        />
        {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
        <button
          onClick={handleAuth}
          className="w-full py-2 bg-white text-black rounded-lg font-medium"
        >
          Enter
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">RPC Tester</h1>
          <p className="text-gray-400 mt-1">
            Compare RPC endpoints and filter stages for the connected wallet.
          </p>
        </div>
        <PhantomWalletButton />
      </div>

      {!connected || !publicKey ? (
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-6 text-gray-300">
          Connect your wallet to run RPC diagnostics.
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-gray-700 bg-gray-900 p-6 space-y-4">
            <div className="flex flex-wrap gap-3 items-center">
              <select
                value={selectedEndpointIndex}
                onChange={(e) =>
                  setSelectedEndpointIndex(Number.parseInt(e.target.value, 10))
                }
                className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              >
                {endpoints.map((ep) => (
                  <option key={ep.index} value={ep.index}>
                    {ep.provider} — {ep.sanitizedUrl}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={autoSelectBest}
                  onChange={(e) => setAutoSelectBest(e.target.checked)}
                />
                Auto-select best RPC
              </label>
              <button
                type="button"
                disabled={isRunningDiagnostics}
                onClick={() => runDiagnostics(publicKey.toString())}
                className="px-4 py-2 bg-white text-black rounded-lg text-sm disabled:opacity-50"
              >
                {isRunningDiagnostics ? "Testing..." : "Test all RPCs"}
              </button>
              <button
                type="button"
                disabled={pipelineLoading}
                onClick={runPipelineBreakdown}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm disabled:opacity-50"
              >
                {pipelineLoading ? "Running..." : "Run filter breakdown"}
              </button>
            </div>

            {bestDiagnostic && (
              <p className="text-sm text-green-400">
                Recommended: {bestDiagnostic.provider} (
                {bestDiagnostic.rawAccountCount} accounts,{" "}
                {bestDiagnostic.getParsedTokenAccountsMs}ms)
              </p>
            )}

            {diagnostics.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-300">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400">
                      <th className="py-2 pr-3">Provider</th>
                      <th className="py-2 pr-3">URL</th>
                      <th className="py-2 pr-3">Slot</th>
                      <th className="py-2 pr-3">Index</th>
                      <th className="py-2 pr-3">Slot ms</th>
                      <th className="py-2 pr-3">Accounts ms</th>
                      <th className="py-2 pr-3">Accounts</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnostics.map((row) => (
                      <tr key={row.index} className="border-b border-gray-800">
                        <td className="py-2 pr-3">{row.provider}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {row.sanitizedUrl}
                        </td>
                        <td className="py-2 pr-3">
                          {row.slotHealthy ? (
                            <span className="text-green-400">OK</span>
                          ) : (
                            <span className="text-red-400" title={row.slotError}>
                              Error
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {row.indexHealthy ? (
                            <span className="text-green-400">OK</span>
                          ) : (
                            <span className="text-red-400" title={row.indexError}>
                              Error
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3">{row.getSlotMs}</td>
                        <td className="py-2 pr-3">
                          {row.getParsedTokenAccountsMs}
                        </td>
                        <td className="py-2 pr-3">{row.rawAccountCount}</td>
                        <td className="py-2">
                          {row.healthy ? (
                            <span className="text-green-400">OK</span>
                          ) : (
                            <span className="text-red-400" title={row.error}>
                              {row.error ?? "Error"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-gray-700 bg-gray-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                Filter stage breakdown
              </h2>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={showDustOnly}
                  onChange={(e) => setShowDustOnly(e.target.checked)}
                />
                Simulate dust-only filter
              </label>
            </div>
            {pipelineError && (
              <p className="text-red-400 text-sm">{pipelineError}</p>
            )}
            {pipelineStages.length > 0 && (
              <table className="w-full text-sm text-left text-gray-300">
                <thead>
                  <tr className="border-b border-gray-700 text-gray-400">
                    <th className="py-2 pr-3">Stage</th>
                    <th className="py-2 pr-3">Count</th>
                    <th className="py-2">Lost vs prior</th>
                  </tr>
                </thead>
                <tbody>
                  {pipelineStages.map((stage) => (
                    <tr key={stage.label} className="border-b border-gray-800">
                      <td className="py-2 pr-3">{stage.label}</td>
                      <td className="py-2 pr-3">{stage.count}</td>
                      <td className="py-2">{stage.lost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
