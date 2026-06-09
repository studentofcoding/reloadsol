/**
 * Developer wallet utilities — Jupiter Universal Wallet compatible.
 * Resolves addresses from publicKey, adapter.publicKey, or base58 strings.
 */

import { PublicKey } from '@solana/web3.js';

/** Built-in dev wallets (always available in client bundles). */
export const DEFAULT_DEV_WALLETS = [
  '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX',
  '2KbA4Z1twQCYZj4MNvX5RKNKh8vWGpiQbGBPcAjtBpYS',
] as const;

type WalletLike =
  | string
  | PublicKey
  | { toBase58?: () => string; toString?: () => string; address?: string; publicKey?: string }
  | null
  | undefined;

let cachedDevWallets: Set<string> | null = null;

function parseWalletList(raw: string): string[] {
  return raw
    .split(',')
    .map((wallet) => wallet.trim())
    .filter((wallet) => wallet.length > 0);
}

function normalizeAddress(address: string): string {
  return address.trim();
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

function getDevWalletSet(): Set<string> {
  if (cachedDevWallets !== null) {
    return cachedDevWallets;
  }

  const fromEnv = parseWalletList(
    process.env.NEXT_PUBLIC_DEV_WALLETS ||
      process.env.DEV_WALLETS ||
      '',
  );

  cachedDevWallets = new Set(
    [...DEFAULT_DEV_WALLETS, ...fromEnv].map(normalizeAddress),
  );

  return cachedDevWallets;
}

/** Check if a wallet address belongs to a developer. */
export function isDevWallet(wallet: WalletLike): boolean {
  const address = toWalletAddress(wallet);
  if (!address) return false;

  const isMatch = getDevWalletSet().has(normalizeAddress(address));

  if (isMatch && process.env.NODE_ENV !== 'production') {
    console.log(`🛠️ Developer wallet detected: ${address.slice(0, 8)}...`);
  }

  return isMatch;
}

/** All configured developer wallets (defaults + env). */
export function getConfiguredDevWallets(): string[] {
  return Array.from(getDevWalletSet());
}

export function clearDevWalletCache(): void {
  cachedDevWallets = null;
}
