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
  const interval = options?.interval ?? '5'
  const params = new URLSearchParams({ interval })
  if (options?.theme) params.set('theme', options.theme)
  return `https://www.gmgn.cc/kline/sol/${tokenMint}?${params.toString()}`
}

export function getGmgnTokenUrl(tokenMint: string): string {
  return `https://gmgn.ai/sol/token/${tokenMint}`;
}

/** GMGN iframe interval param for a trade hold window. */
export function pickGmgnIntervalForWindow(
  entryAt: string | null | undefined,
  exitAt: string | null | undefined,
): string {
  if (!entryAt || !exitAt) return '5';
  const ms = new Date(exitAt).getTime() - new Date(entryAt).getTime();
  if (Number.isNaN(ms) || ms <= 0) return '5';
  const hours = ms / (1000 * 60 * 60);
  if (hours < 2) return '1';
  if (hours < 24) return '5';
  if (hours < 24 * 7) return '60';
  return '1D';
}
