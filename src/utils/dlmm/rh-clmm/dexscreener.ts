import type { Address } from 'viem';
import { CHAINS, type SupportedChainId } from './config';

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  feeTier?: number | string;
  url?: string;
};

const priceCache = new Map<string, { usd: number; at: number }>();
const CACHE_MS = 20_000;

function cacheKey(chainId: SupportedChainId, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}

export async function fetchTokenPairs(tokenAddress: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error ${res.status}`);
  const data = (await res.json()) as { pairs?: DexPair[] | null };
  return data.pairs ?? [];
}

/** Uniswap v3 pairs on our chain, sorted by TVL desc */
export async function fetchUniswapV3PoolsForToken(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<DexPair[]> {
  const slug = CHAINS[chainId].dexscreenerSlug;
  const pairs = await fetchTokenPairs(tokenAddress);
  const filtered = pairs.filter((p) => {
    if (p.chainId?.toLowerCase() !== slug) return false;
    const dex = (p.dexId ?? '').toLowerCase();
    if (dex !== 'uniswap') return false;
    const labels = (p.labels ?? []).map((l) => l.toLowerCase());
    // Exclude v2 and v4; accept unlabeled (legacy) or explicit v3
    if (labels.includes('v2') || labels.includes('v4')) return false;
    if (labels.length && !labels.includes('v3')) return false;
    // v4 poolIds are 32-byte hex (66 chars incl 0x); v3 addresses are 20-byte
    if ((p.pairAddress?.length ?? 0) > 42) return false;
    return true;
  });

  filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return filtered;
}

/** Uniswap v4 pairs on our chain (labels include v4; pairAddress is poolId bytes32) */
export async function fetchUniswapV4PoolsForToken(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<DexPair[]> {
  const slug = CHAINS[chainId].dexscreenerSlug;
  const pairs = await fetchTokenPairs(tokenAddress);
  const filtered = pairs.filter((p) => {
    if (p.chainId?.toLowerCase() !== slug) return false;
    const dex = (p.dexId ?? '').toLowerCase();
    if (dex !== 'uniswap') return false;
    const labels = (p.labels ?? []).map((l) => l.toLowerCase());
    if (!labels.includes('v4')) return false;
    return true;
  });

  filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return filtered;
}

/**
 * Extract USD price of `token` from a DexScreener pair.
 * priceUsd is ALWAYS the base token's USD price — never use it blindly for quote tokens.
 */
function priceUsdFromPair(pair: DexPair, tokenAddress: string): number | null {
  const lower = tokenAddress.toLowerCase();
  const base = pair.baseToken?.address?.toLowerCase();
  const quote = pair.quoteToken?.address?.toLowerCase();
  const baseUsd = Number(pair.priceUsd);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return null;

  if (base === lower) return baseUsd;

  if (quote === lower) {
    // base priced in quote: priceNative ≈ base/quote (quote units per 1 base)
    // so quoteUsd = baseUsd / priceNative
    const priceNative = Number(pair.priceNative);
    if (Number.isFinite(priceNative) && priceNative > 0) {
      const q = baseUsd / priceNative;
      if (Number.isFinite(q) && q > 0) return q;
    }
    // liquidity fallback: quoteUsd ≈ (liq.usd * quote_share) / quote_amount — rough
    const liqUsd = pair.liquidity?.usd;
    const quoteAmt = pair.liquidity?.quote;
    if (liqUsd && quoteAmt && quoteAmt > 0) {
      // assume ~half of pool USD is quote (ok for deep stable/ETH pools only)
      const q = liqUsd / 2 / quoteAmt;
      if (Number.isFinite(q) && q > 0.01) return q; // reject nonsense
    }
  }
  return null;
}

function scorePairForToken(pair: DexPair, tokenAddress: string): number {
  const lower = tokenAddress.toLowerCase();
  const base = pair.baseToken?.address?.toLowerCase();
  const liq = pair.liquidity?.usd ?? 0;
  // Prefer token as base (priceUsd is direct), then high liquidity
  const baseBoost = base === lower ? 1e12 : 0;
  return baseBoost + liq;
}

/**
 * Reliable USD price for a token on a chain.
 */
export async function getTokenPriceUsd(
  chainId: SupportedChainId,
  tokenAddress: Address,
): Promise<number | null> {
  const c = CHAINS[chainId];
  // Native (v4 0x0) prices the same as wrapped
  const resolved: Address =
    tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
      ? c.wrapped
      : tokenAddress;

  const key = cacheKey(chainId, resolved);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.usd;

  const lower = resolved.toLowerCase();

  // Stables
  if (c.usdg && c.usdg.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now() });
    return 1;
  }
  if (c.usdt && c.usdt.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now() });
    return 1;
  }
  if (c.usdc && c.usdc.toLowerCase() === lower) {
    priceCache.set(key, { usd: 1, at: Date.now() });
    return 1;
  }

  const slug = c.dexscreenerSlug;
  const pairs = await fetchTokenPairs(resolved);
  const onChain = pairs.filter((p) => p.chainId?.toLowerCase() === slug);
  const candidates = (onChain.length ? onChain : pairs)
    .slice()
    .sort((a, b) => scorePairForToken(b, lower) - scorePairForToken(a, lower));

  for (const pair of candidates) {
    const px = priceUsdFromPair(pair, lower);
    if (px != null && px > 0) {
      // Sanity: WETH/WBNB shouldn't be under $10 or over $1M
      const isWrapped = c.wrapped.toLowerCase() === lower;
      if (isWrapped && (px < 10 || px > 1_000_000)) continue;
      priceCache.set(key, { usd: px, at: Date.now() });
      return px;
    }
  }

  // Wrapped native: try stable pairs explicitly (USDG/WETH, USDT|USDC/WBNB)
  if (c.wrapped.toLowerCase() === lower) {
    const stables = [c.usdg, c.usdt, c.usdc].filter((a): a is typeof c.wrapped => !!a);
    const stable = stables[0];
    if (stable) {
      const stablePairs = await fetchTokenPairs(stable);
      const match = stablePairs
        .filter((p) => p.chainId?.toLowerCase() === slug)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      for (const pair of match) {
        const px = priceUsdFromPair(pair, lower);
        if (px != null && px > 10 && px < 1_000_000) {
          priceCache.set(key, { usd: px, at: Date.now() });
          return px;
        }
      }
    }
    // Last resort: ETH price from ethereum mainnet WETH
    try {
      const ethPairs = await fetchTokenPairs('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const ethBest = ethPairs
        .filter((p) => p.chainId === 'ethereum')
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (ethBest?.priceUsd) {
        const px = Number(ethBest.priceUsd);
        if (px > 10 && px < 1_000_000) {
          priceCache.set(key, { usd: px, at: Date.now() });
          return px;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

export async function valueUsd(
  chainId: SupportedChainId,
  tokenAddress: Address,
  amountHuman: number,
): Promise<number> {
  const px = await getTokenPriceUsd(chainId, tokenAddress);
  if (px == null) return 0;
  return amountHuman * px;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export function formatTvl(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return formatUsd(n);
}

/** Clear price cache (e.g. after mint for fresh quotes) */
export function clearPriceCache(): void {
  priceCache.clear();
}
