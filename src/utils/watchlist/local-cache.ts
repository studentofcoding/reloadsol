import type { WalletWatchlistEntry } from '@/types/watchlist';

const STORAGE_KEY = 'reloadsol_global_watchlist_v1';

type WatchlistCacheStore = Record<
  string,
  { entries: WalletWatchlistEntry[]; updatedAt: string }
>;

function readStore(): WatchlistCacheStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as WatchlistCacheStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: WatchlistCacheStore): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode errors
  }
}

export function readWatchlistCache(
  walletAddress: string,
): WalletWatchlistEntry[] {
  if (!walletAddress) return [];
  return readStore()[walletAddress]?.entries ?? [];
}

export function writeWatchlistCache(
  walletAddress: string,
  entries: WalletWatchlistEntry[],
): void {
  if (!walletAddress) return;
  const store = readStore();
  store[walletAddress] = {
    entries,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

export function clearWatchlistCache(walletAddress: string): void {
  if (!walletAddress) return;
  const store = readStore();
  delete store[walletAddress];
  writeStore(store);
}
