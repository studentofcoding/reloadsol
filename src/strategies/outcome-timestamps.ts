/**
 * pg timestamptz values become JS Date objects. String(date) uses
 * Date#toString() ("Wed Sep 02 2026 14:23:45 GMT+0700 (...)"), which
 * Postgres rejects (time zone "gmt+0700") and which slice(0, 10) turns
 * into a regime day that is not YYYY-MM-DD.
 */

const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/

/** JS Date#toString(), including a space-padded day ("Sep  2"). */
const JS_DATE_TO_STRING =
  /^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT[+-]\d{4}\b/

export function coerceIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!ISO_TIMESTAMP.test(trimmed) && !JS_DATE_TO_STRING.test(trimmed)) {
    return null
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

export function isBlankTimestamp(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  return false
}
