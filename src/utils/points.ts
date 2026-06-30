import { queryOne } from '@/utils/db';

interface WalletStats {
  points: number;
  tokenCount: number;
}

export const fetchWalletStats = async (walletAddress: string): Promise<WalletStats> => {
  try {
    const data = await queryOne<{ swap_count: number; close_count: number }>(
      `SELECT swap_count, close_count FROM token_operations WHERE wallet_address = $1`,
      [walletAddress],
    );

    if (data) {
      const swapPoints = (data.swap_count || 0) * 10;
      const closePoints = (data.close_count || 0) * 5;
      const totalTokens = (data.swap_count || 0) + (data.close_count || 0);

      return {
        points: swapPoints + closePoints,
        tokenCount: totalTokens,
      };
    }

    return {
      points: 0,
      tokenCount: 0,
    };
  } catch (error) {
    console.error('Error fetching wallet stats:', error);
    return {
      points: 0,
      tokenCount: 0,
    };
  }
};
