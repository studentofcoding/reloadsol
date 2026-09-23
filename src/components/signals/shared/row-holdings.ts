import type { UserToken } from "@/utils/jupiter";
import { TOKENS } from "@/utils/solana";

/** Sum raw and UI balances when a mint has more than one token account. */
export function mergeTokensByMint(tokens: UserToken[]): Map<string, UserToken> {
  const map = new Map<string, UserToken>();
  for (const token of tokens) {
    const mint = token.mintAddress?.trim().toLowerCase();
    if (!mint) continue;
    const prev = map.get(mint);
    if (!prev) {
      map.set(mint, token);
      continue;
    }
    map.set(mint, {
      ...prev,
      balance: prev.balance + token.balance,
      uiAmount: prev.uiAmount + token.uiAmount,
      usdValue: (prev.usdValue || 0) + (token.usdValue || 0),
    });
  }
  return map;
}

export function stableUiBalance(
  holdings: Map<string, UserToken>,
  mint: string,
): number {
  return holdings.get(mint.trim().toLowerCase())?.uiAmount ?? 0;
}

export function usdtUiBalance(holdings: Map<string, UserToken>): number {
  return stableUiBalance(holdings, TOKENS.USDT);
}
