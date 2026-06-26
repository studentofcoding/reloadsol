/** Shared mcap tracker thresholds (no side effects — safe for unit tests). */
export const STOP_LOSS_THRESHOLD = parseFloat(
  process.env.MCAP_STOP_LOSS_THRESHOLD ||
    process.env.NEXT_PUBLIC_MCAP_STOP_LOSS_THRESHOLD ||
    '-50',
)
