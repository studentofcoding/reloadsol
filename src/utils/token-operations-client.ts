interface TokenOperations {
  wallet_address: string;
  close_count: number;
  swap_count: number;
  sol_balance: number;
  last_operation_time: string;
  last_balance_update: string;
  telegram_handle: string | null;
  telegram_verified: boolean;
  telegram_verification_time: string | null;
  tx_level: number;
  ask_for_fund: boolean;
  amount_ask_for_fund: number;
  last_assistance_request: string | null;
}

const OPERATIONS_CACHE_KEY = 'token_operations_cache';
const LAST_SYNC_KEY = 'last_sync_time';

export const getCachedOperations = (): TokenOperations[] => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const cached = localStorage.getItem(OPERATIONS_CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
};

export const cacheOperation = (walletAddress: string, type: 'close' | 'swap', count: number) => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }

  const operations = getCachedOperations();
  const timestamp = new Date().toISOString();
  const existing = operations.find((op) => op.wallet_address === walletAddress);

  if (existing) {
    if (type === 'close') existing.close_count += count;
    else existing.swap_count += count;
    existing.last_operation_time = timestamp;
    existing.last_balance_update = timestamp;
  } else {
    operations.push({
      wallet_address: walletAddress,
      close_count: type === 'close' ? count : 0,
      swap_count: type === 'swap' ? count : 0,
      sol_balance: 0,
      last_operation_time: timestamp,
      last_balance_update: timestamp,
      telegram_handle: null,
      telegram_verified: false,
      telegram_verification_time: null,
      tx_level: 0,
      ask_for_fund: false,
      amount_ask_for_fund: 0,
      last_assistance_request: null,
    });
  }

  localStorage.setItem(OPERATIONS_CACHE_KEY, JSON.stringify(operations));

  syncOperationsToApi().catch((err) =>
    console.error('Failed to sync operations immediately:', err),
  );
};

const shouldSync = (): boolean => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return false;
  }

  const lastSync = localStorage.getItem(LAST_SYNC_KEY);
  if (!lastSync) return true;

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return new Date(lastSync) < fiveMinutesAgo;
};

export const syncOperationsToApi = async () => {
  if (!shouldSync()) return;

  const operations = getCachedOperations();
  if (operations.length === 0) return;

  try {
    const response = await fetch('/api/operations/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations }),
    });

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.statusText}`);
    }

    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      localStorage.setItem(OPERATIONS_CACHE_KEY, '[]');
    }

    console.log('Successfully synced operations at:', new Date().toISOString());
  } catch (error) {
    console.error('Failed to sync operations:', error);
  }
};

/** @deprecated alias */
export const syncOperationsToSupabase = syncOperationsToApi;

export const directUpdateOperation = async (
  walletAddress: string,
  type: 'close' | 'swap',
  count: number,
  solBalance?: number,
) => {
  try {
    const response = await fetch('/api/operations/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, type, count, solBalance }),
    });

    if (!response.ok) {
      throw new Error(`Direct update failed: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Update failed');
    }
  } catch (error) {
    console.error('Failed to update database directly:', error);
    cacheOperation(walletAddress, type, count);
  }
};

export const prepareOperationUpdate = (
  walletAddress: string,
  type: 'close' | 'swap',
  count: number,
  solBalance?: number,
) => {
  const timestamp = new Date().toISOString();
  return {
    wallet_address: walletAddress,
    type,
    count,
    last_operation_time: timestamp,
    ...(solBalance !== undefined && {
      sol_balance: solBalance,
      last_balance_update: timestamp,
    }),
  };
};

export const setupOperationSync = (): NodeJS.Timeout => {
  syncOperationsToApi().catch((err) => console.error('Failed initial sync:', err));

  return setInterval(() => {
    syncOperationsToApi().catch((err) => console.error('Failed periodic sync:', err));
  }, 5 * 60 * 1000);
};

export const TELEGRAM_LINKS = {
  CHANNEL: `https://t.me/${process.env.TELEGRAM_CHANNEL_ID?.replace('@', '')}`,
  BOT: `https://t.me/${process.env.TELEGRAM_BOT_TOKEN?.split(':')[0]}`,
} as const;

export const generateVerificationCode = (walletAddress: string) => {
  return walletAddress.slice(0, 8).toUpperCase();
};
