export type TokenRugSource =
  | 'signals'
  | 'live'
  | 'board'
  | 'tracker'
  | 'tracker-stop'
  | 'signals-label'
  | 'algo-dashboard'
  | 'algo-history'
  | 'dlmm-general'
  | 'gmgn-radar';

export interface TokenRugEntry {
  id: string;
  token_address: string;
  token_symbol: string | null;
  source: TokenRugSource;
  added_at: string;
}

/** @deprecated Use TokenRugSource */
export type DlmmRugSource = TokenRugSource;

/** @deprecated Use TokenRugEntry */
export type DlmmRugEntry = TokenRugEntry;
