import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});

export const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

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
  try {
    const cached = localStorage.getItem(OPERATIONS_CACHE_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
};

// Add operation to cache
export const cacheOperation = (walletAddress: string, type: 'close' | 'swap', count: number) => {
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

  try {
    for (const operation of operations) {
      // First get existing counts
      const { data: existing } = await supabase
        .from('token_operations')
        .select('swap_count, close_count')
        .eq('wallet_address', operation.wallet_address)
        .single();

      // Add new counts to existing counts (or start from 0 if no existing record)
      const newCounts = {
        swap_count: (existing?.swap_count || 0) + operation.swap_count,
        close_count: (existing?.close_count || 0) + operation.close_count,
      };

      // Update with combined counts
      const { error } = await supabase
        .from('token_operations')
        .upsert({
          wallet_address: operation.wallet_address,
          swap_count: newCounts.swap_count,
          close_count: newCounts.close_count,
          sol_balance: operation.sol_balance,
          last_operation_time: operation.last_operation_time,
          last_balance_update: operation.last_balance_update
        }, {
          onConflict: 'wallet_address'
        });

      if (error) throw error;
    }

    // Update last sync time and clear cache after successful sync
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    localStorage.setItem(OPERATIONS_CACHE_KEY, '[]');
    
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
    // First get existing counts
    const { data: existing } = await supabase
      .from('token_operations')
      .select('swap_count, close_count')
      .eq('wallet_address', walletAddress)
      .single();

    const timestamp = new Date().toISOString();
    const updates = {
      wallet_address: walletAddress,
      close_count: type === 'close' ? (existing?.close_count || 0) + count : (existing?.close_count || 0),
      swap_count: type === 'swap' ? (existing?.swap_count || 0) + count : (existing?.swap_count || 0),
      last_operation_time: timestamp,
      ...(solBalance !== undefined && { sol_balance: solBalance, last_balance_update: timestamp }),
    };

    const { error } = await supabase
      .from('token_operations')
      .upsert(updates, {
        onConflict: 'wallet_address'
      });

    if (error) throw error;

    // console.log(`Updated ${type} operation directly in database. Batch results:
    //   - Operation: ${type}
    //   - Successful: ${count}/${options?.totalTokens || count}
    //   - Total ${type} count: ${type === 'close' ? updates.close_count : updates.swap_count}
    // `);
    
    // Don't call cacheOperation after successful direct update to avoid double counting
    // when syncOperationsToSupabase is called
  } catch (error) {
    console.error('Failed to update database directly:', error);
    // Fallback to cache-only if direct update fails
    cacheOperation(walletAddress, type, count);
  }
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
