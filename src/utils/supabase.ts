import { createClient } from '@supabase/supabase-js';

// Environment detection
const isServer = typeof window === 'undefined';

// Server-side configuration (private env vars only)
const getServerSupabaseConfig = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    throw new Error('Server supabase config missing: SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }
  
  return { url, key };
};

// Client-side configuration (will use API proxy instead of direct connection)
const getClientSupabaseConfig = () => {
  // For client-side, we'll create a minimal client that errors on direct use
  // This forces all client-side operations to go through API routes
  return {
    url: 'https://placeholder.supabase.co', // Placeholder URL
    key: 'placeholder-key' // Placeholder key
  };
};

// Create appropriate configuration based on environment
const config = isServer ? getServerSupabaseConfig() : getClientSupabaseConfig();

// Main supabase client - only works properly on server
export const supabase = createClient(config.url, config.key, {
  auth: {
    persistSession: !isServer, // Only persist session on client
    autoRefreshToken: !isServer,
  }
});

// Admin supabase client - server only
export const adminSupabase = isServer 
  ? createClient(config.url, config.key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : supabase; // Fallback to main client on browser (will error appropriately)

// Client-side operations should go through API routes instead
if (!isServer) {
  // Override supabase methods to throw helpful errors on client
  const clientError = () => {
    throw new Error('Direct supabase access not allowed on client. Use API routes instead.');
  };
  
  // We'll keep the client creation for typing but override dangerous methods
  supabase.from = () => {
    throw new Error('Direct supabase.from() not allowed on client. Use fetch("/api/...") instead.');
  };
}

// Telegram Constants
export const TELEGRAM_LINKS = {
  CHANNEL: `https://t.me/${process.env.TELEGRAM_CHANNEL_ID?.replace('@', '')}`,
  BOT: `https://t.me/${process.env.TELEGRAM_BOT_TOKEN?.split(':')[0]}`
} as const;

// Function to generate verification code from wallet
export const generateVerificationCode = (walletAddress: string) => {
  return walletAddress.slice(0, 8).toUpperCase();
};

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

// Local storage key
const OPERATIONS_CACHE_KEY = 'token_operations_cache';
const LAST_SYNC_KEY = 'last_sync_time';

// Get cached operations
export const getCachedOperations = (): TokenOperations[] => {
  // Only run in browser environment
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return []
  }
  
  try {
    const cached = localStorage.getItem(OPERATIONS_CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
};

// Add operation to cache
export const cacheOperation = (walletAddress: string, type: 'close' | 'swap', count: number) => {
  // Only run in browser environment
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return
  }
  
  const operations = getCachedOperations();
  const timestamp = new Date().toISOString();
  const existing = operations.find(op => op.wallet_address === walletAddress);

  if (existing) {
    if (type === 'close') existing.close_count += count;
    else existing.swap_count += count;
    existing.last_operation_time = timestamp;
    existing.last_balance_update = timestamp;
  } else {
    // Create a new entry with appropriate counters
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
      last_assistance_request: null
    });
  }

  localStorage.setItem(OPERATIONS_CACHE_KEY, JSON.stringify(operations));
  
  // Try to sync immediately, but don't block the UI
  syncOperationsToSupabase().catch(err => 
    console.error('Failed to sync operations immediately:', err)
  );
};

// Check if 5 minutes have passed since last sync
const shouldSync = (): boolean => {
  // Only run in browser environment
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return false
  }
  
  const lastSync = localStorage.getItem(LAST_SYNC_KEY);
  if (!lastSync) return true;

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return new Date(lastSync) < fiveMinutesAgo;
};

// Sync cached operations to Supabase
export const syncOperationsToSupabase = async () => {
  if (!shouldSync()) return;
  
  const operations = getCachedOperations();
  if (operations.length === 0) return;

  // Use API instead of direct supabase call
  try {
    // Sync via API
    const response = await fetch('/api/operations/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operations })
    })

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.statusText}`)
    }

    // Only clear cache if we're in browser environment
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      localStorage.setItem(OPERATIONS_CACHE_KEY, '[]');
    }
    
    console.log('Successfully synced operations at:', new Date().toISOString());
  } catch (error) {
    console.error('Failed to sync operations:', error);
  }
};

// Direct update function for immediate database updates
export const directUpdateOperation = async (
  walletAddress: string, 
  type: 'close' | 'swap',
  count: number,
  solBalance?: number,
) => {
  try {
    // Use API for direct updates
    const response = await fetch('/api/operations/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        walletAddress,
        type,
        count,
        solBalance
      })
    })

    if (!response.ok) {
      throw new Error(`Direct update failed: ${response.statusText}`)
    }

    const result = await response.json()
    if (!result.success) {
      throw new Error(result.error || 'Update failed')
    }

    // Don't call cacheOperation after successful direct update to avoid double counting
  } catch (error) {
    console.error('Failed to update database directly:', error);
    // Fallback to cache-only if direct update fails
    cacheOperation(walletAddress, type, count);
  }
};

// Helper function to prepare update data (used by API)
export const prepareOperationUpdate = (walletAddress: string, type: 'close' | 'swap', count: number, solBalance?: number) => {
  const timestamp = new Date().toISOString();
  return {
    wallet_address: walletAddress,
    type,
    count,
    last_operation_time: timestamp,
    ...(solBalance !== undefined && { sol_balance: solBalance, last_balance_update: timestamp }),
  };
};

// Set up interval to sync operations to Supabase
export const setupOperationSync = (): NodeJS.Timeout => {
  // Initial sync on setup
  syncOperationsToSupabase().catch(err => 
    console.error('Failed initial sync:', err)
  );
  
  // Set up interval (every 5 minutes)
  return setInterval(() => {
    syncOperationsToSupabase().catch(err => 
      console.error('Failed periodic sync:', err)
    );
  }, 5 * 60 * 1000); // 5 minutes
};

// Added function to update SOL balance
export const updateWalletBalance = async (walletAddress: string, solBalance: number) => {
  const { error } = await supabase
    .from('token_operations')
    .upsert({
      wallet_address: walletAddress,
      sol_balance: solBalance,
      last_balance_update: new Date().toISOString()
    }, {
      onConflict: 'wallet_address'
    });

  if (error) console.error('Error updating SOL balance:', error);
};

// Function to update telegram verification status
export const updateTelegramVerification = async (
  walletAddress: string,
  isVerified: boolean
): Promise<{ error: any }> => {
  const { error } = await supabase
    .from('token_operations')
    .update({
      telegram_verified: isVerified,
      tx_level: isVerified ? 1 : 0,
      telegram_verification_time: new Date().toISOString()
    })
    .eq('wallet_address', walletAddress);

  return { error };
};

// Function to check telegram verification status and update tx_level
export const checkTelegramVerification = async (
  walletAddress: string
): Promise<boolean> => {
  const { data, error } = await supabase
    .from('token_operations')
    .select('telegram_verified')
    .eq('wallet_address', walletAddress)
    .single();
    
  if (error || !data) return false;
  
  if (data.telegram_verified) {
    // Update tx_level to 1 when verified
    await supabase
      .from('token_operations')
      .update({ tx_level: 1 })
      .eq('wallet_address', walletAddress);
  }
  
  return data.telegram_verified;
};

// Function to get telegram handle
export const getTelegramHandle = async (
  walletAddress: string
): Promise<string | null> => {
  const { data, error } = await supabase
    .from('token_operations')
    .select('telegram_handle')
    .eq('wallet_address', walletAddress)
    .single();
    
  if (error || !data) return null;
  return data.telegram_handle;
};

export interface OffRampTransaction {
  id: string;
  user_wallet: string;
  amount_sol: number;
  amount_idr: number;
  bank_name: string;
  account_number: string;
  account_name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
  e_wallet?: string;
  phone_number?: string;
}

/**
 * Save a new off-ramp transaction to the database
 */
export async function saveOffRampTransaction(
  walletAddress: string,
  transactionId: string,
  amountSol: number,
  estimatedIdr: number,
  bankName: string,
  accountNumber: string,
  accountName: string,
  eWallet?: string,
  phoneNumber?: string
): Promise<void> {
  try {
    const { error } = await adminSupabase
      .from('off_ramp_transactions')
      .insert({
        id: transactionId,
        user_wallet: walletAddress,
        amount_sol: amountSol,
        amount_idr: estimatedIdr,
        bank_name: bankName,
        account_number: accountNumber,
        account_name: accountName,
        e_wallet: eWallet,
        phone_number: phoneNumber,
        status: 'pending'
      });
      
    if (error) throw error;
  } catch (error) {
    console.error('Failed to save off-ramp transaction:', error);
    throw error;
  }
}

/**
 * Get all off-ramp transactions for a specific wallet
 */
export async function getOffRampTransactions(
  walletAddress: string
): Promise<OffRampTransaction[]> {
  try {
    const { data, error } = await adminSupabase
      .from('off_ramp_transactions')
      .select('*')
      .eq('user_wallet', walletAddress)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Failed to fetch off-ramp transactions:', error);
    return [];
  }
}

/**
 * Update the status of an off-ramp transaction
 */
export async function updateOffRampStatus(
  transactionId: string,
  status: 'pending' | 'processing' | 'completed' | 'failed'
): Promise<void> {
  try {
    const { error } = await adminSupabase
      .from('off_ramp_transactions')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', transactionId);
      
    if (error) throw error;
  } catch (error) {
    console.error('Failed to update off-ramp status:', error);
    throw error;
  }
}

/**
 * Track wallet connect event by updating last_connected timestamp.
 */
export const trackWalletConnect = async (walletAddress: string, estimatedLocation: string) => {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('token_operations')
      .upsert({
        wallet_address: walletAddress,
        last_connected: now,
        last_operation_time: now,
        estimated_location: estimatedLocation,
      }, {
        onConflict: 'wallet_address'
      });

    console.log('Wallet connect tracked:', walletAddress, now, estimatedLocation);

    if (error) {
      console.error('Failed to track wallet connect:', error);
    }
  } catch (error) {
    console.error('Error in trackWalletConnect:', error);
  }
};

export const updateAskForFund = async (
  walletAddress: string,
  requiredAmount: number,
  currentBalance: number
) => {
  try {
    const { error } = await supabase
      .from('token_operations')
      .upsert({
        wallet_address: walletAddress,
        ask_for_fund: true,
        amount_ask_for_fund: requiredAmount - currentBalance,
        sol_balance: currentBalance,
        last_balance_update: new Date().toISOString()
      }, {
        onConflict: 'wallet_address'
      });

    if (error) {
      console.error('Error updating assistance request:', error);
      throw error;
    }
  } catch (error) {
    console.error('Failed to update assistance request:', error);
    throw error;
  }
};
