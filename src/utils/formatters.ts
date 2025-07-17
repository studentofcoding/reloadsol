/**
 * Format numbers with appropriate suffixes and decimal places
 * @param num - The number to format
 * @param decimals - Number of decimal places (default: auto-determined)
 * @param compact - Whether to use compact notation (K/M/B) for large numbers (default: true)
 * @returns Formatted number string
 */
export function formatNumber(num: number, decimals?: number, compact: boolean = true): string {
  // Handle edge cases
  if (num === 0) return '0'
  if (!isFinite(num)) return 'N/A'
  if (isNaN(num)) return 'N/A'

  const absNum = Math.abs(num)
  const sign = num < 0 ? '-' : ''

  // For very small numbers, show more precision
  if (absNum < 0.000001 && absNum > 0) {
    return `${sign}< 0.000001`
  }

  // Use compact notation for large numbers if enabled
  if (compact && absNum >= 1000) {
    if (absNum >= 1_000_000_000) {
      const formatted = (absNum / 1_000_000_000).toFixed(decimals ?? 2)
      return `${sign}${formatted}B`
    } else if (absNum >= 1_000_000) {
      const formatted = (absNum / 1_000_000).toFixed(decimals ?? 2)
      return `${sign}${formatted}M`
    } else if (absNum >= 1_000) {
      const formatted = (absNum / 1_000).toFixed(decimals ?? 2)
      return `${sign}${formatted}K`
    }
  }

  // For precise formatting or smaller numbers
  if (decimals !== undefined) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(num)
  }

  // Auto-determine decimal places based on number size
  let autoDecimals: number
  if (absNum >= 1) {
    autoDecimals = 2
  } else if (absNum >= 0.01) {
    autoDecimals = 4
  } else {
    autoDecimals = 6
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: autoDecimals
  }).format(num)
}

/**
 * Format currency values with dollar sign
 * @param num - The number to format
 * @param decimals - Number of decimal places
 * @param compact - Whether to use compact notation
 * @returns Formatted currency string
 */
export function formatCurrency(num: number, decimals?: number, compact: boolean = true): string {
  if (num === 0) return '$0'
  if (!isFinite(num) || isNaN(num)) return '$N/A'
  
  return `$${formatNumber(num, decimals, compact)}`
}

/**
 * Format percentage values
 * @param num - The number to format (as decimal, e.g., 0.05 for 5%)
 * @param decimals - Number of decimal places (default: 2)
 * @param showSign - Whether to show + for positive values (default: false)
 * @returns Formatted percentage string
 */
export function formatPercentage(num: number, decimals: number = 2, showSign: boolean = false): string {
  if (!isFinite(num) || isNaN(num)) return 'N/A%'
  
  const percentage = num * 100
  const sign = showSign && percentage > 0 ? '+' : ''
  
  return `${sign}${percentage.toFixed(decimals)}%`
}

/**
 * Format token amounts with appropriate precision
 * @param amount - Token amount (can be string or number)
 * @param decimals - Token decimals (default: 6)
 * @param displayDecimals - Number of decimal places to display
 * @returns Formatted token amount string
 */
export function formatTokenAmount(amount: string | number, decimals: number = 6, displayDecimals?: number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  
  if (isNaN(num) || !isFinite(num)) return '0'
  
  // Convert from smallest unit to token unit
  const tokenAmount = num / Math.pow(10, decimals)
  
  if (tokenAmount === 0) return '0'
  if (tokenAmount < 0.000001) return '< 0.000001'
  
  return formatNumber(tokenAmount, displayDecimals, false)
}

/**
 * Format time duration in human readable format
 * @param milliseconds - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`
  if (milliseconds < 3600000) return `${(milliseconds / 60000).toFixed(1)}m`
  return `${(milliseconds / 3600000).toFixed(1)}h`
}

/**
 * Format large numbers in a compact way (always uses K/M/B notation)
 * @param num - The number to format
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted compact number string
 */
export function formatCompactNumber(num: number, decimals: number = 1): string {
  return formatNumber(num, decimals, true)
}

/**
 * Format numbers with full precision (never uses K/M/B notation)
 * @param num - The number to format
 * @param decimals - Number of decimal places
 * @returns Formatted precise number string
 */
export function formatPreciseNumber(num: number, decimals?: number): string {
  return formatNumber(num, decimals, false)
}