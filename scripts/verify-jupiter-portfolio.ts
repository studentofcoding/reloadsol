/**
 * Verifies Jupiter portfolio mapping and dust categorization.
 * Run: npx tsx scripts/verify-jupiter-portfolio.ts
 * Live: TEST_WALLET=... BASE_URL=http://localhost:3000 npx tsx scripts/verify-jupiter-portfolio.ts --live
 */

import {
  mapPortfolioToUserTokens,
  type JupiterPortfolioResponse,
} from "../src/utils/jupiter-portfolio";
import {
  categorizeUserTokens,
  DUST_USD_THRESHOLD,
} from "../src/utils/jupiter";

const SAMPLE_PORTFOLIO: JupiterPortfolioResponse = {
  totalValue: 69.6528968977169,
  tokens: [
    {
      id: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      decimals: 9,
      amount: 0.96893348,
      rawAmount: "968933480",
      value: 69.4671649340778,
      price: 71.6944623836074,
    },
    {
      id: "2DdwEtt8qyjMCDHyoQ7tR5kXPRU1xjDB4876jyJQpump",
      symbol: "LIGMA",
      decimals: 6,
      amount: 18146.821903,
      rawAmount: "18146821903",
      value: 0.154205836553952,
      price: 0.000008497677300092,
    },
    {
      id: "28b4z93aauCsSuBEixrS9nytHMzFFgHF7q6YE9btpump",
      symbol: "AFC",
      decimals: 6,
      amount: 8986.495982,
      rawAmount: "8986495982",
      value: 0.0271836702463595,
      price: 0.000003024946575484,
    },
    {
      id: "C2jMEyZuwVrUHiRHbNSExFkCEXQ8h7qcCw9NhMFspump",
      symbol: "SpaceCup",
      decimals: 6,
      amount: 2308.693037,
      rawAmount: "2308693037",
      value: 0.00434245683875827,
      price: 0.000001880915638919,
    },
  ],
  reclaimableCount: 0,
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function runMapperChecks(): void {
  const splTokens = mapPortfolioToUserTokens(SAMPLE_PORTFOLIO);
  assert(splTokens.length === 3, `Expected 3 SPL tokens, got ${splTokens.length}`);

  const spaceCup = splTokens.find((t) => t.symbol === "SpaceCup");
  assert(!!spaceCup, "SpaceCup missing from mapped tokens");
  assert(
    (spaceCup?.usdValue ?? 0) > 0,
    "SpaceCup should have positive Jupiter USD value",
  );

  const { valuable, dust, zeroValue } = categorizeUserTokens(splTokens);
  assert(valuable.length === 0, `Expected 0 valuable tokens, got ${valuable.length}`);
  assert(dust.length === 3, `Expected 3 dust tokens, got ${dust.length}`);
  assert(zeroValue.length === 0, `Expected 0 zero-value tokens, got ${zeroValue.length}`);

  for (const token of dust) {
    assert(
      token.usdValue < DUST_USD_THRESHOLD,
      `${token.symbol} should be under $${DUST_USD_THRESHOLD}`,
    );
  }

  console.log("Mapper checks passed:");
  console.log(`  SPL tokens: ${splTokens.length}`);
  console.log(`  Dust: ${dust.length}, Valuable: ${valuable.length}, Zero-value: ${zeroValue.length}`);
  console.log(
    `  SpaceCup USD: $${spaceCup?.usdValue.toFixed(6)} (Jupiter portfolio value)`,
  );
}

async function runLiveCheck(): Promise<void> {
  const wallet = process.env.TEST_WALLET;
  if (!wallet) {
    console.log("Skipping live check (set TEST_WALLET to enable)");
    return;
  }

  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/jupiter/portfolio?wallet=${encodeURIComponent(wallet)}&include=reclaimableLamports`;
  const response = await fetch(url);
  assert(response.ok, `Live portfolio request failed: ${response.status}`);

  const data = (await response.json()) as JupiterPortfolioResponse & {
    status?: string;
  };
  const portfolio: JupiterPortfolioResponse = {
    totalValue: data.totalValue,
    tokens: data.tokens,
    reclaimableCount: data.reclaimableCount,
    reclaimableLamports: data.reclaimableLamports,
    latencyMs: data.latencyMs,
  };

  const splTokens = mapPortfolioToUserTokens(portfolio);
  const { dust, valuable } = categorizeUserTokens(splTokens);

  console.log("Live portfolio check passed:");
  console.log(`  Wallet: ${wallet}`);
  console.log(`  Total USD: $${portfolio.totalValue.toFixed(2)}`);
  console.log(`  SPL tokens: ${splTokens.length}, dust: ${dust.length}, valuable: ${valuable.length}`);
}

async function main(): Promise<void> {
  runMapperChecks();

  if (process.argv.includes("--live")) {
    await runLiveCheck();
  }

  console.log("All Jupiter portfolio verification checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
