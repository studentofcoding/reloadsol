import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { crossmintWalletService } from '@/utils/crossmint-wallet';

export async function GET(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  try {
    const { userId } = params;

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Get wallet from database
    const { data: wallet, error } = await supabase
      .from('embedded_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (error || !wallet) {
      return NextResponse.json(
        { error: 'Wallet not found' },
        { status: 404 }
      );
    }

    // Get updated balance from Crossmint
    try {
      const balance = await crossmintWalletService.getWalletBalance(wallet.wallet_address);
      
      // Update balance in database
      await supabase
        .from('embedded_wallets')
        .update({ 
          sol_balance: balance.sol,
          last_balance_check: new Date().toISOString()
        })
        .eq('id', wallet.id);

      wallet.sol_balance = balance.sol;
    } catch (balanceError) {
      console.warn('Failed to update balance:', balanceError);
    }

    return NextResponse.json({
      success: true,
      wallet
    });

  } catch (error) {
    console.error('Error retrieving wallet:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve wallet' },
      { status: 500 }
    );
  }
}