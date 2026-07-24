import { Token, tickToPrice } from './uniswap';
import type { SupportedChainId } from './config';
import { CHAINS } from './config';

const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
};

function toSubscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUB[c] ?? c)
    .join('');
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

export function formatHumanPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return n.toExponential(3);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) {
    const s = abs >= 100 ? n.toFixed(2) : abs >= 10 ? n.toFixed(4) : n.toFixed(6);
    return trimZeros(s);
  }
  if (abs >= 1e-3) return trimZeros(n.toFixed(6));
  return formatSubscriptPrice(n);
}

/**
 * Compact tiny prices: 0.0000390 → 0.0₄390
 * (count of zeros after decimal before first non-zero as subscript)
 */
export function formatSubscriptPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n < 0) return `-${formatSubscriptPrice(-n)}`;
  if (n >= 0.001) return formatHumanPrice(n);

  // Use enough precision
  const raw = n.toFixed(20);
  const m = raw.match(/^0\.(0*)([1-9]\d*)/);
  if (!m) return n.toExponential(3);
  const zeroCount = m[1].length;
  // take ~3 significant digits from the rest
  let rest = m[2].replace(/0+$/, '');
  if (rest.length > 3) rest = rest.slice(0, 3);
  return `0.0${toSubscript(zeroCount)}${rest}`;
}

export function priceAtTick(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tick: number;
}): { price: number; inverse: number } {
  const t0 = new Token(params.chainId, params.token0, params.decimals0, params.symbol0);
  const t1 = new Token(params.chainId, params.token1, params.decimals1, params.symbol1);
  const p = tickToPrice(t0, t1, params.tick);
  const price = parseFloat(p.toSignificant(12));
  const inverse = price > 0 ? 1 / price : 0;
  return { price, inverse };
}

function nativeUnit(symbol: string): 'ETH' | 'BNB' | null {
  const s = symbol.toUpperCase();
  if (s === 'WETH' || s === 'ETH') return 'ETH';
  if (s === 'WBNB' || s === 'BNB') return 'BNB';
  return null;
}

/**
 * Compact range for list / mint confirm.
 * When pair includes WETH/WBNB, always show **native per alt token** (price in ETH/BNB),
 * regardless of token0/token1 order (handles inverted pairs).
 * Example: `0.0₅185–0.0₅210 (now 0.0₅190) ETH`
 */
export function formatCompactRange(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  /** Prefer showing this token as the quote (denominator). Default: WETH/WBNB if present. */
  preferQuoteSymbol?: string;
}): string {
  const lo = priceAtTick({ ...params, tick: params.tickLower });
  const hi = priceAtTick({ ...params, tick: params.tickUpper });
  const cur = priceAtTick({ ...params, tick: params.currentTick });

  // Uniswap price = token1 per token0; inverse = token0 per token1
  const n0 = nativeUnit(params.symbol0);
  const n1 = nativeUnit(params.symbol1);

  // Prefer "ETH (or BNB) per 1 alt token" so inverted WETH-as-token1 pairs
  // don't show huge alt-per-ETH numbers.
  if (n0 && !n1) {
    // token0=native, token1=alt → native/alt = inverse
    // tickLower → higher inverse; tickUpper → lower inverse → low–high = hi.inv–lo.inv
    const unit = n0;
    return `${formatSubscriptPrice(hi.inverse)}–${formatSubscriptPrice(lo.inverse)} (now ${formatSubscriptPrice(cur.inverse)}) ${unit}`;
  }
  if (n1 && !n0) {
    // token1=native, token0=alt (inverted) → native/alt = price
    // tickLower → lower price; tickUpper → higher price
    const unit = n1;
    return `${formatSubscriptPrice(lo.price)}–${formatSubscriptPrice(hi.price)} (now ${formatSubscriptPrice(cur.price)}) ${unit}`;
  }

  // No native in pair: plain token1/token0
  return `${formatSubscriptPrice(lo.price)}–${formatSubscriptPrice(hi.price)} (now ${formatSubscriptPrice(cur.price)})`;
}

/**
 * Current spot as native-per-alt when possible, else token1/token0.
 * e.g. `0.0₅190 ETH` or `1.2345 USDC/TOKEN`
 */
export function formatSpotPrice(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tick: number;
}): string {
  const cur = priceAtTick({ ...params, tick: params.tick });
  const n0 = nativeUnit(params.symbol0);
  const n1 = nativeUnit(params.symbol1);
  if (n0 && !n1) {
    return `${formatSubscriptPrice(cur.inverse)} ${n0}`;
  }
  if (n1 && !n0) {
    return `${formatSubscriptPrice(cur.price)} ${n1}`;
  }
  return `${formatSubscriptPrice(cur.price)} ${params.symbol1}/${params.symbol0}`;
}

export function formatPriceRange(params: {
  chainId: number;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  tickLower: number;
  tickUpper: number;
  currentTick?: number;
}): string {
  const lo = priceAtTick({ ...params, tick: params.tickLower });
  const hi = priceAtTick({ ...params, tick: params.tickUpper });
  let line =
    `${formatHumanPrice(lo.price)} → ${formatHumanPrice(hi.price)} ${params.symbol1} per ${params.symbol0}\n` +
    `  (${formatHumanPrice(hi.inverse)} → ${formatHumanPrice(lo.inverse)} ${params.symbol0} per ${params.symbol1})`;
  if (params.currentTick != null) {
    const cur = priceAtTick({ ...params, tick: params.currentTick });
    line += `\n  now: ${formatHumanPrice(cur.price)} ${params.symbol1}/${params.symbol0}`;
  }
  return line;
}

export function uniswapPositionUrl(
  chainId: SupportedChainId,
  tokenId: string | bigint,
  protocol: 'v3' | 'v4' = 'v3',
): string {
  // Uniswap app path slugs differ from DexScreener for some chains
  const appSlug = CHAINS[chainId].dexscreenerSlug;
  const ver = protocol === 'v4' ? 'v4' : 'v3';
  return `https://app.uniswap.org/positions/${ver}/${appSlug}/${tokenId.toString()}`;
}

export function formatAge(openedAtMs: number | null | undefined): string {
  if (!openedAtMs) return '?';
  const h = Math.max(0, (Date.now() - openedAtMs) / 3_600_000);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** ETH-style value: E 0.0123 */
export function formatEthVal(ethAmount: number): string {
  if (!Number.isFinite(ethAmount) || ethAmount === 0) return 'E 0.0000';
  if (Math.abs(ethAmount) >= 1) return `E ${ethAmount.toFixed(4)}`;
  if (Math.abs(ethAmount) >= 0.0001) return `E ${ethAmount.toFixed(4)}`;
  return `E ${ethAmount.toFixed(6)}`;
}
