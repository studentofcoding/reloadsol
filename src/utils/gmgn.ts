const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** Pick the memecoin mint to chart (non-SOL/USDC/USDT leg). */
export function getPoolChartMint(
  tokenXAddress?: string,
  tokenYAddress?: string,
): string | null {
  if (!tokenXAddress || !tokenYAddress) return null;
  if (QUOTE_MINTS.has(tokenXAddress)) return tokenYAddress;
  if (QUOTE_MINTS.has(tokenYAddress)) return tokenXAddress;
  return tokenXAddress;
}

export function getGmgnKlineUrl(
  tokenMint: string,
  options?: { interval?: string; theme?: 'dark' | 'light' },
): string {
  const interval = options?.interval ?? '5m';
  const theme = options?.theme ?? 'dark';
  const params = new URLSearchParams({ interval, theme });
  return `https://www.gmgn.cc/kline/sol/${tokenMint}?${params.toString()}`;
}

export function getGmgnTokenUrl(tokenMint: string): string {
  return `https://gmgn.ai/sol/token/${tokenMint}`;
}
