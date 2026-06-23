/**
 * Verifies Shyft wallet token mapping and dust categorization.
 * Run: npx tsx scripts/verify-shyft-wallet.ts
 * Live: TEST_WALLET=... BASE_URL=http://localhost:3000 npx tsx scripts/verify-shyft-wallet.ts --live
 */

import {
  mapShyftTokensToUserTokens,
  normalizeShyftBalance,
  type ShyftWalletToken,
} from "../src/utils/shyft-wallet";
import {
  categorizeUserTokens,
  DUST_USD_THRESHOLD,
  type UserToken,
} from "../src/utils/jupiter";

/** Sample from Shyft Wallet API docs (all_tokens response). */
const SAMPLE_SHYFT_TOKENS: ShyftWalletToken[] = [
  {
    address: "3VJyo1n5EkBGh6uEcnKA1Bf8EgVnvrK3XjcDZDDXsPLF",
    balance: 888888888,
    associated_account: "DQJkt16VMhJ1nPp2T8F5oxxu1wuo2rfQBiiyNR1WpEn2",
    info: {
      decimals: 5,
      name: "Flonk",
      symbol: "FLONK",
      image:
        "https://assets.coingecko.com/coins/images/34189/large/IMG_9974.png?1704267040",
    },
  },
  {
    address: "Dx1Lq5FjangW5ifRMEogAiakm24LyB5AoHmQifepvNjV",
    balance: 5,
    associated_account: "4iUphU2p1ATF5PnyRpjBeZtC2Mm1eErVUdnhXdYWYn4E",
    info: {
      decimals: 9,
      name: "BabyBonk",
      symbol: "BABYBONK",
      image:
        "https://assets.coingecko.com/coins/images/34741/large/babybonk_logo.jpg?1706018014",
    },
  },
  {
    address: "FLUXBmPhT3Fd1EDVFdg46YREqHBeNypn1h4EbnTzWERX",
    balance: 35457651.1169,
    associated_account: "8yGQMGJyjmZQ7rmUjhscquQfk7Yvr26k2wMA7FrxQQg6",
    info: {
      decimals: 5,
      name: "Fluxbot",
      symbol: "FLUXB",
      image:
        "https://assets.coingecko.com/coins/images/33018/large/fluxbot.jpeg?1700193761",
    },
  },
  {
    address: "So11111111111111111111111111111111111111112",
    balance: 40429.706350151,
    associated_account: "EY8wxYMKHL45fBFWPW4HMk9med7RKf2R3ygVWkPYx55z",
    info: {
      decimals: 9,
      name: "Wrapped SOL",
      symbol: "SOL",
      image:
        "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    },
  },
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function runBalanceNormalizationChecks(): void {
  const flonk = normalizeShyftBalance(888888888, 5);
  assert(
    Math.abs(flonk.ui - 8888.88888) < 0.001,
    `Flonk UI should be ~8888.89, got ${flonk.ui}`,
  );

  const flux = normalizeShyftBalance(35457651.1169, 5);
  assert(
    Math.abs(flux.ui - 35457651.1169) < 0.001,
    `FLUXB UI should preserve decimal, got ${flux.ui}`,
  );

  const baby = normalizeShyftBalance(5, 9);
  assert(baby.ui === 5, `BabyBonk UI should be 5, got ${baby.ui}`);

  console.log("Balance normalization checks passed");
}

function runMapperChecks(): void {
  const splTokens = mapShyftTokensToUserTokens(SAMPLE_SHYFT_TOKENS);
  assert(splTokens.length === 3, `Expected 3 SPL tokens, got ${splTokens.length}`);

  const flonk = splTokens.find((t) => t.symbol === "FLONK");
  assert(!!flonk, "FLONK missing from mapped tokens");
  assert(
    Math.abs((flonk?.uiAmount ?? 0) - 8888.88888) < 0.001,
    "FLONK uiAmount incorrect",
  );

  const flux = splTokens.find((t) => t.symbol === "FLUXB");
  assert(!!flux, "FLUXB missing from mapped tokens");
  assert(
    Math.abs((flux?.uiAmount ?? 0) - 35457651.1169) < 0.001,
    "FLUXB uiAmount incorrect",
  );

  const tokensWithPrices: UserToken[] = splTokens.map((token, index) => ({
    ...token,
    usdValue: [0.5, 0.004, 2.5][index] ?? 0,
    isLoadingPrice: false,
  }));

  const { valuable, dust, zeroValue } = categorizeUserTokens(tokensWithPrices);
  assert(valuable.length === 1, `Expected 1 valuable token, got ${valuable.length}`);
  assert(dust.length === 2, `Expected 2 dust tokens, got ${dust.length}`);
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
}

async function runLiveCheck(): Promise<void> {
  const wallet = process.env.TEST_WALLET;
  if (!wallet) {
    console.log("Skipping live check (set TEST_WALLET to enable)");
    return;
  }

  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/shyft/wallet/all_tokens?wallet=${encodeURIComponent(wallet)}&network=mainnet-beta`;
  const response = await fetch(url);
  assert(response.ok, `Live Shyft request failed: ${response.status}`);

  const data = (await response.json()) as {
    tokens: ShyftWalletToken[];
    tokenCount?: number;
  };

  const splTokens = mapShyftTokensToUserTokens(data.tokens ?? []);
  const { dust, valuable } = categorizeUserTokens(
    splTokens.map((t) => ({ ...t, usdValue: 0, isLoadingPrice: false })),
  );

  console.log("Live Shyft check passed:");
  console.log(`  Wallet: ${wallet}`);
  console.log(`  Raw token count: ${data.tokenCount ?? data.tokens?.length ?? 0}`);
  console.log(`  SPL tokens (excl. SOL): ${splTokens.length}, dust: ${dust.length}, valuable: ${valuable.length}`);
}

async function main(): Promise<void> {
  runBalanceNormalizationChecks();
  runMapperChecks();

  if (process.argv.includes("--live")) {
    await runLiveCheck();
  }

  console.log("All Shyft wallet verification checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
