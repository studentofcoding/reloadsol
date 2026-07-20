import { sendTelegramAlert } from "@/utils/telegram";
import {
  defaultAmountLamports,
  defaultSlippageBps,
  minEdgeLamports,
  quoteTriArb,
} from "./quote";
import { loadSolArbPairs } from "./pairs";
import type { TriArbQuoteResult } from "./types";

export type SolArbScanHit = {
  label?: string;
  quote: TriArbQuoteResult;
};

export type SolArbScanResult = {
  success: boolean;
  scanned: number;
  hits: SolArbScanHit[];
  errors: Array<{ label?: string; mintA: string; mintB: string; error: string }>;
  amountLamports: string;
  minEdgeLamports: string;
  notified: boolean;
};

/** Quote curated pairs; alert when net edge >= threshold. */
export async function runSolArbScan(options?: {
  notify?: boolean;
}): Promise<SolArbScanResult> {
  const pairs = loadSolArbPairs();
  const amountLamports = defaultAmountLamports();
  const slippageBps = defaultSlippageBps();
  const minEdge = minEdgeLamports();
  const hits: SolArbScanHit[] = [];
  const errors: SolArbScanResult["errors"] = [];

  for (const pair of pairs) {
    try {
      const quote = await quoteTriArb({
        mintA: pair.mintA,
        mintB: pair.mintB,
        amountLamports,
        slippageBps,
      });
      if (BigInt(quote.netSolLamports) >= minEdge) {
        hits.push({ label: pair.label, quote });
      }
    } catch (error) {
      errors.push({
        label: pair.label,
        mintA: pair.mintA,
        mintB: pair.mintB,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let notified = false;
  if (options?.notify !== false && hits.length > 0) {
    const lines = hits.map((h) => {
      const name = h.label ?? `${h.quote.mintA.slice(0, 4)}…/${h.quote.mintB.slice(0, 4)}…`;
      const netSol = Number(h.quote.netSolLamports) / 1e9;
      return `• <b>${name}</b> net ${netSol.toFixed(6)} SOL (${h.quote.roiPct.toFixed(2)}% ROI)`;
    });
    await sendTelegramAlert(
      `⚡ <b>SOL Arb edge</b>\n\n${lines.join("\n")}`,
      { parseMode: "HTML" },
    );
    notified = true;
  }

  return {
    success: true,
    scanned: pairs.length,
    hits,
    errors,
    amountLamports,
    minEdgeLamports: minEdge.toString(),
    notified,
  };
}
