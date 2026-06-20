import { formatDistanceToNow } from 'date-fns'

/** Fixed display timezone for all user-facing timestamps (storage stays UTC). */
export const APP_TIMEZONE = 'Asia/Bangkok' as const

const DEFAULT_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

const DEFAULT_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}

export function toUtcIso(date: Date = new Date()): string {
  return date.toISOString()
}

export function parseInstant(value: string | number | Date): Date {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000
    return new Date(ms)
  }
  return new Date(value)
}

export function formatAppDateTime(
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    ...DEFAULT_DATETIME_OPTIONS,
    ...options,
  }).format(date)
}

export function formatAppTime(
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    ...DEFAULT_TIME_OPTIONS,
    ...options,
  }).format(date)
}

export function formatAppDate(
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    ...DEFAULT_DATE_OPTIONS,
    ...options,
  }).format(date)
}

/** e.g. `21:26 GMT+7 20/06/2026` — Discord / notification style */
export function formatAppDateTimeWithZone(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return ''
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = getAppLocalParts(date)
  const hh = String(parts.hour).padStart(2, '0')
  const mm = String(parts.minute).padStart(2, '0')
  const dd = String(parts.day).padStart(2, '0')
  const mo = String(parts.month).padStart(2, '0')
  return `${hh}:${mm} GMT+7 ${dd}/${mo}/${parts.year}`
}

export function formatAppTimeWithZone(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return ''
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = getAppLocalParts(date)
  const hh = String(parts.hour).padStart(2, '0')
  const mm = String(parts.minute).padStart(2, '0')
  return `${hh}:${mm} GMT+7`
}

export function formatAppRelative(
  value: string | number | Date | null | undefined,
  options?: { addSuffix?: boolean },
): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = parseInstant(value)
  if (Number.isNaN(date.getTime())) return '—'
  return formatDistanceToNow(date, { addSuffix: options?.addSuffix ?? true })
}

export interface AppLocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function getAppLocalParts(date: Date = new Date()): AppLocalParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Current wall-clock time string in Asia/Bangkok (for notifications). */
export function formatAppNow(): string {
  return formatAppDateTime(new Date())
}

/** Current time only in Asia/Bangkok, e.g. `21:26 GMT+7`. */
export function formatAppNowWithZone(): string {
  return formatAppTimeWithZone(new Date())
}

export function getAppLocalWeekday(date: Date = new Date()): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'short',
  }).format(date)
  const index: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  return index[weekday] ?? 0
}

export function getAppLocalDayName(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'long',
  }).format(date)
}
