export type TradeListSortMode =
  | "date_desc"
  | "date_asc"
  | "pnl_desc"
  | "pnl_asc";

export const TRADE_LIST_SORT_OPTIONS: Array<{
  value: TradeListSortMode;
  label: string;
}> = [
  { value: "date_desc", label: "Date newest" },
  { value: "date_asc", label: "Date oldest" },
  { value: "pnl_desc", label: "PnL +" },
  { value: "pnl_asc", label: "PnL −" },
];

export function compareBySortMode(
  mode: TradeListSortMode,
  aDate: number,
  bDate: number,
  aPnl: number | undefined,
  bPnl: number | undefined,
): number {
  if (mode === "date_desc") return bDate - aDate;
  if (mode === "date_asc") return aDate - bDate;

  const aHas = aPnl !== undefined && Number.isFinite(aPnl);
  const bHas = bPnl !== undefined && Number.isFinite(bPnl);
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (!aHas && !bHas) return bDate - aDate;

  const diff = (aPnl as number) - (bPnl as number);
  return mode === "pnl_desc" ? -diff : diff;
}

/** History cashflow stand-in: sell/close +, buy −. */
export function signedSolForHistoryRecord(record: {
  operationType: string;
  solAmount?: number;
}): number {
  const amount = record.solAmount ?? 0;
  if (record.operationType === "buy") return -amount;
  return amount;
}
