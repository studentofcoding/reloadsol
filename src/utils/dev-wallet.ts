/**
 * Developer wallet utilities — Jupiter Universal Wallet compatible.
 * Resolves addresses from publicKey, adapter.publicKey, or base58 strings.
 * Sol and Robinhood allowlists are separate: a Sol pubkey never grants RH
 * dev UI, and the RH deployer never grants Sol-only tools.
 */

import { PublicKey } from '@solana/web3.js';
import type { AppNetwork } from '@/utils/app-network';

export const DEFAULT_SOL_DEV_WALLETS = [
  '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX',
  '2KbA4Z1twQCYZj4MNvX5RKNKh8vWGpiQbGBPcAjtBpYS',
] as const;

/** RH BatchExecutor owner / deployer. */
export const DEFAULT_RH_DEV_WALLETS = [
  '0x795b5c0c89fC5D3b0De6c04141C3F1b6C340603D',
] as const;

/** Built-in defaults (Sol + RH). Prefer the per-chain lists when checking access. */
export const DEFAULT_DEV_WALLETS = [
  ...DEFAULT_SOL_DEV_WALLETS,
  ...DEFAULT_RH_DEV_WALLETS,
] as const;

type WalletLike =
  | string
  | PublicKey
  | { toBase58?: () => string; toString?: () => string; address?: string; publicKey?: string }
  | null
  | undefined;

let cachedSol: Set<string> | null = null;
let cachedRh: Set<string> | null = null;

function parseWalletList(raw: string): string[] {
  return raw
    .split(',')
    .map((wallet) => wallet.trim())
    .filter((wallet) => wallet.length > 0);
}

function isEvmAddress(address: string): boolean {
  return address.startsWith('0x') || address.startsWith('0X');
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  return isEvmAddress(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * Normalize any wallet public key shape (Jupiter / Solana PublicKey / Wallet Standard).
 */
export function toWalletAddress(wallet: WalletLike): string | null {
  if (!wallet) return null;

  if (typeof wallet === 'string') {
    const trimmed = wallet.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (wallet instanceof PublicKey) {
    return wallet.toBase58();
  }

  if (typeof wallet === 'object') {
    if (typeof wallet.address === 'string' && wallet.address.trim()) {
      return wallet.address.trim();
    }

    if (typeof wallet.publicKey === 'string' && wallet.publicKey.trim()) {
      return wallet.publicKey.trim();
    }

    if (typeof wallet.toBase58 === 'function') {
      try {
        const address = wallet.toBase58().trim();
        if (address) return address;
      } catch {
        // fall through
      }
    }

    // Cross-bundle PublicKey (nested @solana/web3.js from wallet libs)
    try {
      const address = new PublicKey(wallet as PublicKey).toBase58();
      if (address) return address;
    } catch {
      // fall through
    }

    if (typeof wallet.toString === 'function') {
      const raw = wallet.toString().trim();
      if (raw && raw !== '[object Object]' && raw.length >= 32) {
        return raw;
      }
    }
  }

  return null;
}

function envWallets(): { sol: string[]; rh: string[] } {
  const fromEnv = parseWalletList(
    process.env.NEXT_PUBLIC_DEV_WALLETS || process.env.DEV_WALLETS || '',
  );
  const sol: string[] = [];
  const rh: string[] = [];
  for (const w of fromEnv) {
    if (isEvmAddress(w)) rh.push(w);
    else sol.push(w);
  }
  return { sol, rh };
}

function getSolDevWalletSet(): Set<string> {
  if (cachedSol !== null) return cachedSol;
  cachedSol = new Set(
    [...DEFAULT_SOL_DEV_WALLETS, ...envWallets().sol].map(normalizeAddress),
  );
  return cachedSol;
}

function getRhDevWalletSet(): Set<string> {
  if (cachedRh !== null) return cachedRh;
  cachedRh = new Set(
    [...DEFAULT_RH_DEV_WALLETS, ...envWallets().rh].map(normalizeAddress),
  );
  return cachedRh;
}

function setForNetwork(network?: AppNetwork): Set<string> {
  if (network === 'robinhood') return getRhDevWalletSet();
  if (network === 'sol') return getSolDevWalletSet();
  return new Set([...getSolDevWalletSet(), ...getRhDevWalletSet()]);
}

/** Check if a wallet is a developer wallet. Pass `network` to keep Sol/RH lists apart. */
export function isDevWallet(wallet: WalletLike, network?: AppNetwork): boolean {
  const address = toWalletAddress(wallet);
  if (!address) return false;

  const normalized = normalizeAddress(address);
  if (network === 'robinhood' && !isEvmAddress(address)) return false;
  if (network === 'sol' && isEvmAddress(address)) return false;

  const isMatch = setForNetwork(network).has(normalized);

  if (isMatch && process.env.NODE_ENV !== 'production') {
    console.log(`🛠️ Developer wallet detected: ${address.slice(0, 8)}...`);
  }

  return isMatch;
}

/** All configured developer wallets (Sol + RH defaults + env). */
export function getConfiguredDevWallets(): string[] {
  return Array.from(setForNetwork());
}

export function clearDevWalletCache(): void {
  cachedSol = null;
  cachedRh = null;
}
