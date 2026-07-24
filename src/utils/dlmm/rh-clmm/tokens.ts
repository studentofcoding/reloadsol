import type { Address } from 'viem';
import { erc20Abi } from './abis';
import { getPublicClient, getHotWalletAddress } from './clients';
import { CHAINS, type SupportedChainId } from './config';

export type TokenMeta = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

/** Uniswap v4 native currency sentinel (and Relay native). */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as Address;

export function isNativeTokenAddress(address: Address | string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN;
}

const metaCache = new Map<string, TokenMeta>();

/**
 * ERC-20 metadata. For native (address zero) returns chain native meta
 * without calling a contract (v4 currencies use 0x0 for ETH/BNB).
 */
export async function getTokenMeta(
  chainId: SupportedChainId,
  address: Address,
): Promise<TokenMeta> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = metaCache.get(key);
  if (hit) return hit;

  // Uniswap v4 / Relay native — not an ERC-20
  if (isNativeTokenAddress(address)) {
    const c = CHAINS[chainId];
    const meta: TokenMeta = {
      address: NATIVE_TOKEN,
      symbol: c.nativeSymbol,
      name: c.nativeSymbol,
      decimals: 18,
    };
    metaCache.set(key, meta);
    return meta;
  }

  const client = getPublicClient(chainId);
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unknown'),
  ]);

  const meta: TokenMeta = {
    address,
    symbol: String(symbol),
    name: String(name),
    decimals: Number(decimals),
  };
  metaCache.set(key, meta);
  return meta;
}

export async function getTokenBalance(
  chainId: SupportedChainId,
  token: Address,
  owner?: Address,
): Promise<bigint> {
  const client = getPublicClient(chainId);
  const who = owner ?? getHotWalletAddress();
  if (isNativeTokenAddress(token)) {
    return client.getBalance({ address: who });
  }
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
  });
}

export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < BigInt(0);
  const a = neg ? -amount : amount;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = a / base;
  const frac = a % base;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, '');
  const s = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${s}` : s;
}

export function parsePercentOfBalance(balance: bigint, percent: number): bigint {
  if (percent <= 0 || percent > 100) throw new Error('percent must be 1–100');
  // percent with 2 decimals max via basis points
  const bps = Math.round(percent * 100); // 25.5% → 2550 bps of 10000? Wait
  // Use: amount = balance * percent / 100
  // Support 2 decimal percent: multiply by 100 first
  const scaled = Math.round(percent * 100); // 25 → 2500 meaning 25.00%
  return (balance * BigInt(scaled)) / BigInt(10000);
}

/** Human float → raw units (avoids float dust; max 8 fractional digits) */
export function humanToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  const places = Math.min(Math.max(decimals, 0), 18);
  const s = amount.toFixed(Math.min(places, 8));
  const neg = s.startsWith('-');
  const bare = neg ? s.slice(1) : s;
  const [w, f = ''] = bare.split('.');
  const whole = BigInt(w || '0');
  const frac = (f + '0'.repeat(places)).slice(0, places);
  const raw = whole * BigInt(10) ** BigInt(places) + BigInt(frac || '0');
  return neg ? -raw : raw;
}

export type SizeMode = 'percent' | 'fixed';

/**
 * Resolve mint deposit size from prefs.
 * - percent: balancePercent of effective balance
 * - fixed: fixedAmountHuman in deposit-token units (e.g. 0.1 WETH)
 * Caps at effective; throws if zero / below dust.
 */
export function resolveDepositAmount(
  effective: bigint,
  opts: {
    sizeMode: SizeMode;
    balancePercent: number;
    fixedAmountHuman: number;
    decimals: number;
    symbol?: string;
  },
): bigint {
  let amount: bigint;
  if (opts.sizeMode === 'fixed') {
    amount = humanToRaw(opts.fixedAmountHuman, opts.decimals);
    if (amount <= BigInt(0)) {
      throw new Error(`Fixed amount is 0 — set Fix 0.05/0.1/… in /settings`);
    }
    if (amount > effective) {
      const have = Number(effective) / 10 ** opts.decimals;
      throw new Error(
        `Need ${opts.fixedAmountHuman} ${opts.symbol ?? 'tokens'} but only ~${have.toFixed(6)} available`,
      );
    }
  } else {
    amount = parsePercentOfBalance(effective, opts.balancePercent);
    if (amount <= BigInt(0)) throw new Error('Deposit amount is 0 — increase % or fund wallet');
  }
  return amount;
}

export function humanToFloat(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
