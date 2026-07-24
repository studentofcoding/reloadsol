export type WalletWatchlistEntry = {
  id: string;
  wallet_address: string;
  token_address: string;
  token_symbol: string | null;
  logo_url: string | null;
  initial_price_usd: number | null;
  added_at: string;
  chain?: 'sol' | 'robinhood';
};
