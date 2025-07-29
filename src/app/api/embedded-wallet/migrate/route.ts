import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

// Add this import for the RPC proxy
import { createConnection } from '@/utils/connection';

interface MigrateAssetsRequest {
  userId: string;
  destinationWallet: string;
  assets: {
    sol: number;
    tokens: Array<{
      mint: string;
      amount: string;
      decimals: number;
    }>;
  };
}

export async function POST(request: NextRequest) {
  try {
    const { userId, destinationWallet, assets }: MigrateAssetsRequest = await request.json();

    if (!userId || !destinationWallet || !assets) {
      return NextResponse.json(
        { error: 'User ID, destination wallet, and assets are required' },
        { status: 400 }
      );
    }

    // Validate destination wallet address
    try {
      new PublicKey(destinationWallet);
    } catch {
      return NextResponse.json(
        { error: 'Invalid destination wallet address' },
        { status: 400 }
      );
    }

    // Get user's embedded wallet from database
    const { data: walletData, error: walletError } = await supabase
      .from('embedded_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (walletError || !walletData) {
      return NextResponse.json(
        { error: 'Embedded wallet not found for user' },
        { status: 404 }
      );
    }

    // Use the secure connection utility instead of direct connection
    const connection = createConnection('mainnet');
    const sourceWallet = new PublicKey(walletData.wallet_address);
    const destinationWalletPubkey = new PublicKey(destinationWallet);

    const migrationPlan = {
      transactions: [] as any[],
      totalTransactions: 0,
      estimatedFees: 0
    };

    // Plan token transfers
    for (const token of assets.tokens) {
      const mintPubkey = new PublicKey(token.mint);
      
      // Get source token account
      const sourceTokenAccount = await getAssociatedTokenAddress(mintPubkey, sourceWallet);
      
      // Get destination token account (may need to be created)
      const destinationTokenAccount = await getAssociatedTokenAddress(mintPubkey, destinationWalletPubkey);
      
      // Check if destination token account exists
      const destinationAccountInfo = await connection.getAccountInfo(destinationTokenAccount);
      
      const transaction = {
        type: 'token_transfer',
        mint: token.mint,
        amount: token.amount,
        sourceAccount: sourceTokenAccount.toString(),
        destinationAccount: destinationTokenAccount.toString(),
        needsAccountCreation: !destinationAccountInfo
      };

      migrationPlan.transactions.push(transaction);
    }

    // Plan SOL transfer (keep some for fees)
    if (assets.sol > 0.01) {
      const transferAmount = Math.floor((assets.sol - 0.01) * 1e9); // Keep 0.01 SOL for fees
      
      if (transferAmount > 0) {
        migrationPlan.transactions.push({
          type: 'sol_transfer',
          amount: transferAmount,
          amountSol: transferAmount / 1e9
        });
      }
    }

    migrationPlan.totalTransactions = migrationPlan.transactions.length;
    migrationPlan.estimatedFees = migrationPlan.totalTransactions * 0.000005; // Rough estimate

    // Log migration attempt
    console.log('Migration plan created:', {
      userId,
      sourceWallet: sourceWallet.toString(),
      destinationWallet,
      totalTransactions: migrationPlan.totalTransactions,
      tokenTransfers: assets.tokens.length,
      solTransfer: assets.sol > 0.01
    });

    return NextResponse.json({
      success: true,
      migrationPlan,
      message: 'Migration plan created successfully'
    });

  } catch (error: any) {
    console.error('Migration planning failed:', error);
    return NextResponse.json(
      { error: `Migration planning failed: ${error.message}` },
      { status: 500 }
    );
  }
}

// GET endpoint to check migration status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Get user's embedded wallet
    const { data: walletData, error: walletError } = await supabase
      .from('embedded_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (walletError || !walletData) {
      return NextResponse.json(
        { error: 'Embedded wallet not found' },
        { status: 404 }
      );
    }

    // Use the secure connection utility instead of direct connection
    const connection = createConnection('mainnet');
    const walletPubkey = new PublicKey(walletData.wallet_address);
    
    const solBalance = await connection.getBalance(walletPubkey);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM_ID
    });

    const hasAssets = solBalance > 10000 || tokenAccounts.value.some(account => {
      const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
      return amount && amount > 0;
    });

    return NextResponse.json({
      walletAddress: walletData.wallet_address,
      hasAssets,
      solBalance: solBalance / 1e9,
      tokenCount: tokenAccounts.value.length,
      lastChecked: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Migration status check failed:', error);
    return NextResponse.json(
      { error: `Status check failed: ${error.message}` },
      { status: 500 }
    );
  }
}