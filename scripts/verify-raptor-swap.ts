/**
 * Verifies Solana Tracker Raptor quote mapping and proxy routes.
 * Run: npx tsx scripts/verify-raptor-swap.ts
 * Live: BASE_URL=http://localhost:3000 npx tsx scripts/verify-raptor-swap.ts --live
 */

import {
  mapRaptorQuoteToDisplay,
  type RaptorQuoteResponse,
} from "../src/utils/solanatracker-raptor";
import { TOKENS } from "../src/utils/solana";

const SAMPLE_QUOTE: RaptorQuoteResponse = {
  inputMint: TOKENS.SOL,
  outputMint: TOKENS.USDC,
  amountIn: "1000000",
  amountOut: "14321000",
  minAmountOut: "14249400",
  feeAmount: "25000",
  priceImpact: 0.0008,
  slippageBps: 200,
  routePlan: [{ dex: "raydium", pool: "test-pool" }],
  contextSlot: 314159265,
  timeTaken: 0.012,
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function runMapperChecks(): void {
  const mapped = mapRaptorQuoteToDisplay(SAMPLE_QUOTE, "1000000");
  assert(mapped.outAmount === "14321000", "outAmount should match Raptor amountOut");
  assert(mapped.minAmountOut === "14249400", "minAmountOut should match");
  assert(mapped.slippageBps === 200, "slippageBps should match");
  assert(mapped.priceImpact === 0.0008, "priceImpact should match");

  console.log("Mapper checks passed:");
  console.log(`  outAmount: ${mapped.outAmount}`);
  console.log(`  minAmountOut: ${mapped.minAmountOut}`);
  console.log(`  slippageBps: ${mapped.slippageBps}`);
}

async function runLiveChecks(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";

  const quoteUrl = `${baseUrl}/api/solanatracker/quote?inputMint=${TOKENS.SOL}&outputMint=${TOKENS.USDC}&amount=1000000&slippageBps=200`;
  const quoteResponse = await fetch(quoteUrl);
  assert(quoteResponse.ok, `Live quote failed: ${quoteResponse.status}`);
  const quote = (await quoteResponse.json()) as RaptorQuoteResponse;
  assert(!!quote.amountOut, "Live quote missing amountOut");

  const healthResponse = await fetch(`${baseUrl}/api/solanatracker/health`);
  assert(healthResponse.ok, `Health check failed: ${healthResponse.status}`);

  const testWallet = process.env.TEST_WALLET ?? "3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX";
  const swapResponse = await fetch(`${baseUrl}/api/solanatracker/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPublicKey: testWallet,
      inputMint: TOKENS.SOL,
      outputMint: TOKENS.USDC,
      amount: "1000000",
      slippageBps: 200,
      priorityFeeLamports: 30000,
    }),
  });
  assert(swapResponse.ok, `Live swap build failed: ${swapResponse.status}`);
  const swap = (await swapResponse.json()) as { swapTransaction?: string };
  assert(!!swap.swapTransaction, "Live swap missing swapTransaction");

  console.log("Live Raptor checks passed:");
  console.log(`  Quote amountOut: ${quote.amountOut}`);
  console.log(`  Swap tx length: ${swap.swapTransaction?.length ?? 0} chars`);
}

async function main(): Promise<void> {
  runMapperChecks();

  if (process.argv.includes("--live")) {
    await runLiveChecks();
  } else {
    console.log("Skipping live checks (pass --live to hit /api/solanatracker/*)");
  }

  console.log("All Raptor verification checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
