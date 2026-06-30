import { query, queryOne } from '@/utils/db';

export const updateWalletBalance = async (walletAddress: string, solBalance: number) => {
  try {
    await query(
      `INSERT INTO token_operations (wallet_address, sol_balance, last_balance_update)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_address) DO UPDATE SET
         sol_balance = EXCLUDED.sol_balance,
         last_balance_update = EXCLUDED.last_balance_update`,
      [walletAddress, solBalance, new Date().toISOString()],
    );
  } catch (error) {
    console.error('Error updating SOL balance:', error);
  }
};

export const updateTelegramVerification = async (
  walletAddress: string,
  isVerified: boolean,
): Promise<{ error: unknown }> => {
  try {
    await query(
      `UPDATE token_operations SET
         telegram_verified = $2,
         tx_level = $3,
         telegram_verification_time = $4
       WHERE wallet_address = $1`,
      [walletAddress, isVerified, isVerified ? 1 : 0, new Date().toISOString()],
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
};

export const checkTelegramVerification = async (walletAddress: string): Promise<boolean> => {
  const row = await queryOne<{ telegram_verified: boolean }>(
    `SELECT telegram_verified FROM token_operations WHERE wallet_address = $1`,
    [walletAddress],
  );

  if (!row) return false;

  if (row.telegram_verified) {
    await query(`UPDATE token_operations SET tx_level = 1 WHERE wallet_address = $1`, [
      walletAddress,
    ]);
  }

  return row.telegram_verified;
};

export const getTelegramHandle = async (walletAddress: string): Promise<string | null> => {
  const row = await queryOne<{ telegram_handle: string | null }>(
    `SELECT telegram_handle FROM token_operations WHERE wallet_address = $1`,
    [walletAddress],
  );
  return row?.telegram_handle ?? null;
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

export async function saveOffRampTransaction(
  walletAddress: string,
  transactionId: string,
  amountSol: number,
  estimatedIdr: number,
  bankName: string,
  accountNumber: string,
  accountName: string,
  eWallet?: string,
  phoneNumber?: string,
): Promise<void> {
  await query(
    `INSERT INTO off_ramp_transactions (
       id, user_wallet, amount_sol, amount_idr, bank_name,
       account_number, account_name, e_wallet, phone_number, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
    [
      transactionId,
      walletAddress,
      amountSol,
      estimatedIdr,
      bankName,
      accountNumber,
      accountName,
      eWallet ?? null,
      phoneNumber ?? null,
    ],
  );
}

export async function getOffRampTransactions(
  walletAddress: string,
): Promise<OffRampTransaction[]> {
  try {
    const { rows } = await query<OffRampTransaction>(
      `SELECT * FROM off_ramp_transactions
       WHERE user_wallet = $1
       ORDER BY created_at DESC`,
      [walletAddress],
    );
    return rows;
  } catch (error) {
    console.error('Failed to fetch off-ramp transactions:', error);
    return [];
  }
}

export async function updateOffRampStatus(
  transactionId: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
): Promise<void> {
  await query(
    `UPDATE off_ramp_transactions SET status = $2, updated_at = $3 WHERE id = $1`,
    [transactionId, status, new Date().toISOString()],
  );
}

export const trackWalletConnect = async (
  walletAddress: string,
  estimatedLocation: string,
) => {
  try {
    const now = new Date().toISOString();
    await query(
      `INSERT INTO token_operations (
         wallet_address, last_connected, last_operation_time, estimated_location
       ) VALUES ($1, $2, $2, $3)
       ON CONFLICT (wallet_address) DO UPDATE SET
         last_connected = EXCLUDED.last_connected,
         last_operation_time = EXCLUDED.last_operation_time,
         estimated_location = EXCLUDED.estimated_location`,
      [walletAddress, now, estimatedLocation],
    );
    console.log('Wallet connect tracked:', walletAddress, now, estimatedLocation);
  } catch (error) {
    console.error('Error in trackWalletConnect:', error);
  }
};

export const updateAskForFund = async (
  walletAddress: string,
  requiredAmount: number,
  currentBalance: number,
) => {
  await query(
    `INSERT INTO token_operations (
       wallet_address, ask_for_fund, amount_ask_for_fund, sol_balance, last_balance_update
     ) VALUES ($1, true, $2, $3, $4)
     ON CONFLICT (wallet_address) DO UPDATE SET
       ask_for_fund = true,
       amount_ask_for_fund = EXCLUDED.amount_ask_for_fund,
       sol_balance = EXCLUDED.sol_balance,
       last_balance_update = EXCLUDED.last_balance_update`,
    [
      walletAddress,
      requiredAmount - currentBalance,
      currentBalance,
      new Date().toISOString(),
    ],
  );
};
