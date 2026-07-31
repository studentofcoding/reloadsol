// Trading-hours gating extracted from src/app/api/trending/track/route.ts (REL-19).
import {
  formatAppNowWithZone,
  getAppLocalDayName,
  getAppLocalParts,
  getAppLocalWeekday,
} from '@/utils/datetime'

export function isWithinTradingHours(): { allowed: boolean; reason?: string; currentTime?: string } {
  const parts = getAppLocalParts(new Date())
  const timeString = formatAppNowWithZone()

  // Trading allowed from 16:00 to 04:00 GMT+7
  // This means: 15:00-23:59 and 00:00-05:59
  const isAllowed = parts.hour >= 15 || parts.hour < 6

  return {
    allowed: isAllowed,
    reason: isAllowed ? undefined : `Trading restricted outside 16:00-04:00 GMT+7. Current time: ${timeString}`,
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
