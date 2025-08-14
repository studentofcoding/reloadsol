export function calculateGainPercentage(currentPrice: number, initialPrice: number, context?: string): number {
  if (!initialPrice || initialPrice <= 0) {
    const contextMsg = context ? ` (${context})` : ''
    console.warn(`Invalid initial price for gain calculation${contextMsg}:`, initialPrice)
    return 0
  }

  // Round to 4 decimal places to avoid floating point precision issues
  return Math.round(((currentPrice - initialPrice) / initialPrice) * 10000) / 100
}

export function calculatePeakPrice(currentPrice: number, existingPeakPrice: number): number {
  // Ensure we don't store invalid peak prices
  if (currentPrice <= 0) return existingPeakPrice

  // If no existing peak price (0), set current as peak
  if (!existingPeakPrice) return currentPrice

  // Only update peak if current is higher
  return currentPrice > existingPeakPrice ? currentPrice : existingPeakPrice
}

export function shouldRunDailySummary(currentTime: Date, lastSummaryTime: Date | null): boolean {
  if (!lastSummaryTime) {
    return true // No previous summary, run it
  }

  // Check if it's been more than 23 hours since last summary
  const hoursSinceLastSummary = (currentTime.getTime() - lastSummaryTime.getTime()) / (1000 * 60 * 60)

  // Run daily summary once per day (allow 23+ hours gap to avoid missing due to slight timing differences)
  return hoursSinceLastSummary >= 23
}

export function shouldRunPnLUpdate(currentTime: Date): boolean {
  const hour = currentTime.getUTCHours()
  const minute = currentTime.getUTCMinutes()

  // Run PnL update at 2 AM UTC (allow 5-minute window: 2:00-2:05)
  return hour === 2 && minute < 5
}