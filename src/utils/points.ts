import { supabase } from '@/utils/supabase';

interface WalletStats {
  points: number;
  tokenCount: number;
}

export const fetchWalletStats = async (walletAddress: string): Promise<WalletStats> => {
  try {
    const { data, error } = await supabase
      .from('token_operations')
      .select('swap_count, close_count')
      .eq('wallet_address', walletAddress)
      .single();

    if (error) throw error;

    if (data) {
      const swapPoints = (data.swap_count || 0) * 10;
      const closePoints = (data.close_count || 0) * 5;
      const totalTokens = (data.swap_count || 0) + (data.close_count || 0);
      
      return {
        points: swapPoints + closePoints,
        tokenCount: totalTokens
      };
    }

    return {
      points: 0,
      tokenCount: 0
    };
  } catch (error) {
    console.error('Error fetching wallet stats:', error);
    return {
      points: 0,
      tokenCount: 0
    };
  }
}; 