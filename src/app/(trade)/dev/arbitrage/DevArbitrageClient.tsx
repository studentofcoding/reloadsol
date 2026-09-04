"use client";

import React, { useCallback, useMemo, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { executeClientSwap } from "@/utils/swap-executor";
import type { TriArbQuoteResult } from "@/utils/sol-arb/types";
import { SOL_MINT } from "@/utils/sol-arb/types";
import { parseArbLog, type ArbLogParseResult } from "@/utils/sol-arb/parse-log";

type TabId = "run" | "log";

type LegStatus = {
  leg: string;
  status: "pending" | "ok" | "fail";
  signature?: string;
  error?: string;
};

function lamportsToSol(lamports: string | number): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

function RunTab() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  const [mintA, setMintA] = useState("");
  const [mintB, setMintB] = useState("");
  const [solAmount, setSolAmount] = useState("0.1");
  const [slippageBps, setSlippageBps] = useState(300);
  const [quote, setQuote] = useState<TriArbQuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legStatuses, setLegStatuses] = useState<LegStatus[]>([]);
  const [mode, setMode] = useState<"sequential" | "atomic">("sequential");

  const amountLamports = (() => {
    const n = Number.parseFloat(solAmount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(Math.round(n * 1e9));
  })();

  const runQuote = useCallback(async () => {
    setError(null);
    setQuote(null);
    setLegStatuses([]);
    if (!amountLamports) {
      setError("Enter a positive SOL amount");
      return;
    }
    if (!mintA.trim() || !mintB.trim()) {
      setError("mintA and mintB required");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/sol-arb/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintA: mintA.trim(),
          mintB: mintB.trim(),
          amountLamports,
          slippageBps,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Quote failed");
      setQuote(data.quote as TriArbQuoteResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [amountLamports, mintA, mintB, slippageBps]);

  const runSequential = useCallback(async () => {
    if (!publicKey || !signTransaction || !quote || !amountLamports) {
      setError("Connect wallet and quote first");
      return;
    }
    setExecuting(true);
    setError(null);
    const statuses: LegStatus[] = [
      { leg: "SOL→A", status: "pending" },
      { leg: "A→B", status: "pending" },
      { leg: "B→SOL", status: "pending" },
    ];
    setLegStatuses([...statuses]);

    const steps = [
      { label: "SOL→A", inputMint: SOL_MINT, outputMint: quote.mintA },
      { label: "A→B", inputMint: quote.mintA, outputMint: quote.mintB },
      { label: "B→SOL", inputMint: quote.mintB, outputMint: SOL_MINT },
    ];

    let amountIn = quote.inSolLamports;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        try {
          const result = await executeClientSwap({
            userPublicKey: publicKey.toBase58(),
            inputMint: step.inputMint,
            outputMint: step.outputMint,
            amount: amountIn,
            slippageBps: quote.slippageBps,
            connection,
            signTransaction,
            direct: false,
            maxHops: quote.maxHopsArbitrage,
          });
          statuses[i] = {
            leg: step.label,
            status: "ok",
            signature: result.signature,
          };
          setLegStatuses([...statuses]);
          if (!result.outAmount) {
            throw new Error("Missing outAmount — holding inventory");
          }
          amountIn = result.outAmount;
        } catch (legErr) {
          statuses[i] = {
            leg: step.label,
            status: "fail",
            error: legErr instanceof Error ? legErr.message : String(legErr),
          };
          setLegStatuses([...statuses]);
          setError(
            `Aborted at ${step.label}: ${statuses[i]!.error}. Inventory held.`,
          );
          return;
        }
      }
    } finally {
      setExecuting(false);
    }
  }, [publicKey, signTransaction, quote, amountLamports, connection]);

  const runAtomic = useCallback(async () => {
    if (!publicKey || !signTransaction || !amountLamports) {
      setError("Connect wallet and set amount first");
      return;
    }
    setExecuting(true);
    setError(null);
    setLegStatuses([{ leg: "atomic SOL→A→B→SOL", status: "pending" }]);
    try {
      const res = await fetch("/api/sol-arb/execute-atomic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "prepare",
          mintA: mintA.trim(),
          mintB: mintB.trim(),
          amountLamports,
          slippageBps,
          userPublicKey: publicKey.toBase58(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Atomic prepare failed");
      setQuote(data.quote as TriArbQuoteResult);

      const tx = VersionedTransaction.deserialize(
        Buffer.from(data.swapTransaction as string, "base64"),
      );
      const signed = await signTransaction(tx);
      const { submitSignedSwap, confirmSwapSignature } = await import(
        "@/utils/swap-executor"
      );
      const sendResult = await submitSignedSwap({
        signedTx: signed,
        prepared: {
          provider: "jupiter_lite",
          swapTransaction: data.swapTransaction as string,
          outAmount: data.expectedOutSolLamports as string,
        },
        connection,
      });
      await confirmSwapSignature({
        signature: sendResult.signature,
        via: sendResult.via,
        checkViaRaptor: sendResult.checkViaRaptor,
        connection,
        blockhash: signed.message.recentBlockhash,
      });
      setLegStatuses([
        {
          leg: "atomic SOL→A→B→SOL",
          status: "ok",
          signature: sendResult.signature,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLegStatuses([
        { leg: "atomic SOL→A→B→SOL", status: "fail", error: msg },
      ]);
    } finally {
      setExecuting(false);
    }
  }, [
    publicKey,
    signTransaction,
    amountLamports,
    mintA,
    mintB,
    slippageBps,
    connection,
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="block text-sm text-gray-300">
          Mint A
          <input
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 font-mono text-sm"
            value={mintA}
            onChange={(e) => setMintA(e.target.value)}
            placeholder="Token A mint"
          />
        </label>
        <label className="block text-sm text-gray-300">
          Mint B
          <input
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 font-mono text-sm"
            value={mintB}
            onChange={(e) => setMintB(e.target.value)}
            placeholder="Token B mint"
          />
        </label>
        <div className="flex gap-3">
          <label className="block text-sm text-gray-300 flex-1">
            SOL amount
            <input
              className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              value={solAmount}
              onChange={(e) => setSolAmount(e.target.value)}
            />
          </label>
          <label className="block text-sm text-gray-300 w-32">
            Slippage bps
            <input
              type="number"
              className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2"
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            className={`px-3 py-1 rounded ${mode === "sequential" ? "bg-white text-black" : "bg-gray-800"}`}
            onClick={() => setMode("sequential")}
          >
            Sequential (L0)
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded ${mode === "atomic" ? "bg-white text-black" : "bg-gray-800"}`}
            onClick={() => setMode("atomic")}
          >
            Atomic (L1)
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={runQuote}
          disabled={loading || executing}
          className="px-4 py-2 rounded bg-gray-100 text-black font-semibold disabled:opacity-50"
        >
          {loading ? "Quoting…" : "Quote"}
        </button>
        <button
          type="button"
          onClick={mode === "atomic" ? runAtomic : runSequential}
          disabled={executing || loading || (mode === "sequential" && !quote)}
          className="px-4 py-2 rounded bg-emerald-500 text-black font-semibold disabled:opacity-50"
        >
          {executing ? "Executing…" : "Confirm"}
        </button>
      </div>

      {error && (
        <div className="text-red-400 text-sm border border-red-900/50 rounded p-3">
          {error}
        </div>
      )}

      {quote && (
        <div className="border border-gray-800 rounded p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">In</span>
            <span>{lamportsToSol(quote.inSolLamports)} SOL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Out (quoted)</span>
            <span>{lamportsToSol(quote.outSolLamports)} SOL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Net</span>
            <span
              className={quote.profitable ? "text-emerald-400" : "text-red-400"}
            >
              {lamportsToSol(quote.netSolLamports)} SOL ({quote.roiPct.toFixed(2)}
              %)
            </span>
          </div>
          <div className="text-gray-500 text-xs">
            hops={quote.maxHopsArbitrage} · slippage={quote.slippageBps}bps
          </div>
          <ul className="mt-2 space-y-1 text-xs font-mono text-gray-400">
            {quote.legs.map((leg) => (
              <li key={leg.leg}>
                {leg.leg}: {leg.provider} in={leg.inAmount} → out={leg.outAmount}
              </li>
            ))}
          </ul>
        </div>
      )}

      {legStatuses.length > 0 && (
        <ul className="space-y-1 text-sm">
          {legStatuses.map((s) => (
            <li key={s.leg} className="flex gap-2 flex-wrap">
              <span
                className={
                  s.status === "ok"
                    ? "text-emerald-400"
                    : s.status === "fail"
                      ? "text-red-400"
                      : "text-gray-400"
                }
              >
                [{s.status}]
              </span>
              <span>{s.leg}</span>
              {s.signature && (
                <span className="font-mono text-xs text-gray-500 truncate">
                  {s.signature}
                </span>
              )}
              {s.error && <span className="text-red-400 text-xs">{s.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LogLabTab() {
  const [paste, setPaste] = useState("");
  const parsed: ArbLogParseResult = useMemo(() => parseArbLog(paste), [paste]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Paste a freeform trade table or JSON from{" "}
        <code className="text-gray-300">/api/sol-arb/*</code>. Readable is
        best-effort; Raw is your paste unchanged.
      </p>
      <textarea
        className="w-full h-40 bg-gray-950 border border-gray-700 rounded px-3 py-2 font-mono text-xs text-gray-200"
        placeholder="Paste log or JSON here…"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-gray-800 rounded p-3 space-y-3 min-h-[200px]">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Readable</h3>
            <span className="text-xs text-gray-500">{parsed.kind}</span>
          </div>
          {parsed.totals && (
            <div className="text-sm space-y-1 border border-gray-800 rounded p-2">
              {parsed.totals.solSpent != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">SOL spent</span>
                  <span>{parsed.totals.solSpent.toFixed(6)}</span>
                </div>
              )}
              {parsed.totals.solReceived != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">SOL received</span>
                  <span>{parsed.totals.solReceived.toFixed(6)}</span>
                </div>
              )}
              {parsed.totals.netSol != null && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Net</span>
                  <span
                    className={
                      parsed.totals.netSol >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                    }
                  >
                    {parsed.totals.netSol.toFixed(6)}
                    {parsed.totals.roiPct != null
                      ? ` (${parsed.totals.roiPct.toFixed(2)}%)`
                      : ""}
                  </span>
                </div>
              )}
            </div>
          )}
          {parsed.rows.length === 0 ? (
            <p className="text-xs text-gray-500">No rows parsed yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-1 pr-2">Time</th>
                    <th className="py-1 pr-2">Wallet</th>
                    <th className="py-1 pr-2">Action</th>
                    <th className="py-1 pr-2">Amount</th>
                    <th className="py-1">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((row, i) => (
                    <tr key={i} className="border-t border-gray-900 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {row.time ?? "—"}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {row.wallet ?? "—"}
                      </td>
                      <td className="py-1 pr-2">{row.action}</td>
                      <td className="py-1 pr-2 font-mono">{row.amount ?? "—"}</td>
                      <td className="py-1 text-gray-500 max-w-[220px] truncate">
                        {row.usd ?? row.detail ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {parsed.parseNotes.length > 0 && (
            <ul className="text-xs text-gray-500 list-disc pl-4">
              {parsed.parseNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="border border-gray-800 rounded p-3 space-y-2 min-h-[200px]">
          <h3 className="font-semibold text-sm">Raw</h3>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-gray-400 max-h-[480px] overflow-auto">
            {parsed.raw || "(empty)"}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function DevArbitrageClient() {
  const [tab, setTab] = useState<TabId>("run");

  return (
    <div className="max-w-5xl mx-auto text-white space-y-6">
      <div>
        <h1 className="text-2xl font-bold">SOL Arbitration</h1>
        <p className="text-gray-400 text-sm mt-1">
          Dev console — quote/execute SOL→A→B→SOL and decode pasted logs.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        <button
          type="button"
          className={`px-3 py-1.5 rounded ${tab === "run" ? "bg-white text-black" : "bg-gray-800 text-gray-300"}`}
          onClick={() => setTab("run")}
        >
          Run
        </button>
        <button
          type="button"
          className={`px-3 py-1.5 rounded ${tab === "log" ? "bg-white text-black" : "bg-gray-800 text-gray-300"}`}
          onClick={() => setTab("log")}
        >
          Log lab
        </button>
      </div>

      {tab === "run" ? <RunTab /> : <LogLabTab />}
    </div>
  );
}
