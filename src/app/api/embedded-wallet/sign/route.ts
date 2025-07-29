import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { crossmintWalletService } from '@/utils/crossmint-wallet';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

interface SignTransactionRequest {
  userId: string;
  transaction: string; // Base64 encoded transaction
  walletLocator?: string; // Optional, will be derived from userId if not provided
}

interface SignAllTransactionsRequest {
  userId: string;
  transactions: string[]; // Array of Base64 encoded transactions
  walletLocator?: string; // Optional, will be derived from userId if not provided
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, transaction, transactions, walletLocator } = body;

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Get wallet from database to verify ownership
    const { data: wallet, error } = await supabase
      .from('embedded_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true }) // Get the oldest (first) wallet
      .limit(1)
      .single();

    if (error || !wallet) {
      return NextResponse.json(
        { error: 'Wallet not found or not active' },
        { status: 404 }
      );
    }

    console.log('📋 Found wallet in database:', {
      user_id: wallet.user_id,
      wallet_address: wallet.wallet_address,
      wallet_type: wallet.wallet_type,
      crossmint_wallet_id: wallet.crossmint_wallet_id,
      created_at: wallet.created_at
    });

    // Use provided walletLocator or construct from database info
    let locator: string;
    if (walletLocator) {
      locator = walletLocator;
      console.log('🔗 Using provided wallet locator:', locator);
    } else {
      // Construct locator using the wallet address from database
      // The wallet address IS the crossmint wallet ID we need to use
      const walletAddress = wallet.wallet_address || wallet.crossmint_wallet_id;

      // For MPC wallets, we need to use the correct format
      // Try to construct the locator using the userId format first
      locator = crossmintWalletService.createWalletLocator('userId', userId, 'solana-mpc-wallet');

      console.log('🔗 Constructed wallet locator from database:', {
        dbWalletAddress: walletAddress,
        dbWalletType: wallet.wallet_type,
        constructedLocator: locator
      });

      // Verify this wallet exists with Crossmint
      try {
        const crossmintWallet = await crossmintWalletService.getWallet(locator);
        console.log('✅ Verified wallet exists with Crossmint:', {
          address: crossmintWallet.address,
          type: crossmintWallet.type,
          expectedAddress: walletAddress
        });

        // Ensure we're using the correct wallet (the one from database)
        if (crossmintWallet.address !== walletAddress) {
          console.warn('⚠️ Crossmint wallet address mismatch!', {
            crossmintAddress: crossmintWallet.address,
            databaseAddress: walletAddress
          });

          // If addresses don't match, we need to find the correct locator
          // This might happen if there are multiple wallets
          throw new Error('Wallet address mismatch - need to find correct wallet');
        }
      } catch (verifyError: any) {
        console.error('❌ Wallet verification failed:', verifyError.message);

        // Instead of creating a new wallet, return an error
        // We should NOT create duplicate wallets
        return NextResponse.json(
          {
            error: 'Wallet exists in database but not accessible via Crossmint. Please contact support.',
            details: {
              databaseWallet: walletAddress,
              userId: userId,
              error: verifyError.message
            }
          },
          { status: 500 }
        );
      }
    }

    try {
      if (transactions && Array.isArray(transactions)) {
        // Sign multiple transactions
        const signedTransactions = [];

        for (const tx of transactions) {
          const signResult = await crossmintWalletService.signTransaction({
            walletLocator: locator,
            transaction: tx,
            chain: 'solana'
          });

          // Handle pending status for MPC wallets
          if (signResult.status === 'pending') {
            console.log('⏳ Transaction signing is pending (MPC wallet):', signResult.id);
          }

          signedTransactions.push({
            signature: signResult.signature,
            status: signResult.status,
            id: signResult.id
          });
        }

        return NextResponse.json({
          success: true,
          signatures: signedTransactions
        });

      } else if (transaction) {
        // Sign single transaction
        const signResult = await crossmintWalletService.signTransaction({
          walletLocator: locator,
          transaction,
          chain: 'solana'
        });

        // Handle pending status for MPC wallets
        if (signResult.status === 'pending') {
          console.log('⏳ Transaction signing is pending (MPC wallet):', signResult.id);
        }

        return NextResponse.json({
          success: true,
          signature: signResult.signature,
          status: signResult.status,
          id: signResult.id
        });

      } else {
        return NextResponse.json(
          { error: 'Either transaction or transactions array is required' },
          { status: 400 }
        );
      }

    } catch (signingError: any) {
      console.error('Failed to sign transaction(s):', signingError);
      return NextResponse.json(
        { error: `Failed to sign transaction: ${signingError.message}` },
        { status: 500 }
      );
    }

  } catch (error: any) {
    console.error('Error in embedded wallet signing:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET endpoint to check signing status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const signatureId = searchParams.get('id');
    const userId = searchParams.get('userId');

    if (!signatureId || !userId) {
      return NextResponse.json(
        { error: 'Signature ID and User ID are required' },
        { status: 400 }
      );
    }

    // Verify wallet ownership
    const { data: wallet, error } = await supabase
      .from('embedded_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (error || !wallet) {
      return NextResponse.json(
        { error: 'Wallet not found or not active' },
        { status: 404 }
      );
    }

    // Note: Crossmint doesn't seem to have a direct status check endpoint
    // This would need to be implemented based on their API documentation
    return NextResponse.json({
      success: true,
      message: 'Status check not implemented yet - check Crossmint API docs'
    });

  } catch (error: any) {
    console.error('Error checking signature status:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}