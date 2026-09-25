// Trading-hours gating extracted from src/app/api/trending/track/route.ts (REL-19).
import {
  formatAppNowWithZone,
  getAppLocalDayName,
  getAppLocalParts,
  getAppLocalWeekday,
} from '@/utils/datetime'

/**
 * Trading window in app-local time (Asia/Bangkok, GMT+7): 16:00 → 04:00.
 * Single source of truth — the gate and every message quoting the window derive from
 * these, so the enforced hours and the displayed ones cannot drift apart again.
 *
 * Measured 2026-09-25 (strategy_outcomes, entry hour in GMT+7): for the only strategies
 * this gate actually governs (`scalper`, `att`) the hours just outside this window were
 * materially worse — `scalper` averaged −15.1% PnL in 15:00/04:00/05:00 vs −2.8%
 * in-window, and `att` −39.1% vs −11.9%. The check previously admitted 15:00–05:59,
 * an extra hour at each end, while the messages claimed 16:00–04:00.
 */
export const TRADING_START_HOUR = 16
export const TRADING_END_HOUR = 4
export const TRADING_HOURS_LABEL = '16:00 - 04:00 GMT+7'

export function isWithinTradingHours(): { allowed: boolean; reason?: string; currentTime?: string } {
  const parts = getAppLocalParts(new Date())
  const timeString = formatAppNowWithZone()

  const isAllowed = parts.hour >= TRADING_START_HOUR || parts.hour < TRADING_END_HOUR

  return {
    allowed: isAllowed,
    reason: isAllowed ? undefined : `Trading restricted outside ${TRADING_HOURS_LABEL}. Current time: ${timeString}`,
    currentTime: timeString
  }
}

/**
 * Checks if the current day is a weekend (Saturday or Sunday) or weekday (Monday-Friday)
 * @returns Object with day type information
 */
export function isDayTypeWeekend(): { isWeekend: boolean; dayType: 'weekend' | 'weekday'; dayName: string } {
  const now = new Date()
  const dayOfWeek = getAppLocalWeekday(now)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
  const dayName = getAppLocalDayName(now)

  return {
    isWeekend,
    dayType: isWeekend ? 'weekend' : 'weekday',
    dayName
  }
}
