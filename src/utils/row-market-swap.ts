/**
 * Signals and mcap-tracker rows both send through this function.
 * It is the tracker market swap: Jupiter V2 quote → impact gate → auto-cap → sign/send.
 * Early Enter Noul / soft-active is not consulted.
 */
export { runTrackerMarketSwap as rowMarketSwap } from "@/utils/tracker-market-swap";
