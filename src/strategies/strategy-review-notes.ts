import { query } from '@/utils/db'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS strategy_review_notes (
  period_key TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

let ensurePromise: Promise<void> | null = null

export async function ensureStrategyReviewNotesTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensurePromise = null
        throw err
      })
  }
  await ensurePromise
}

export async function listStrategyReviewNotes(params?: {
  periodKeys?: string[]
}): Promise<Record<string, string>> {
  await ensureStrategyReviewNotesTable()
  const keys = params?.periodKeys?.filter(Boolean) ?? []
  if (keys.length > 0) {
    const { rows } = await query<{ period_key: string; note: string }>(
      `SELECT period_key, note FROM strategy_review_notes
       WHERE period_key = ANY($1::text[])`,
      [keys],
    )
    return Object.fromEntries(rows.map((r) => [r.period_key, r.note ?? '']))
  }
  const { rows } = await query<{ period_key: string; note: string }>(
    `SELECT period_key, note FROM strategy_review_notes
     ORDER BY period_key DESC
     LIMIT 52`,
  )
  return Object.fromEntries(rows.map((r) => [r.period_key, r.note ?? '']))
}

/** Upsert note; empty string deletes the row. */
export async function upsertStrategyReviewNote(
  periodKey: string,
  note: string,
): Promise<{ periodKey: string; note: string; deleted: boolean }> {
  await ensureStrategyReviewNotesTable()
  const key = periodKey.trim()
  if (!key) throw new Error('period_key required')
  const text = note.trim()

  if (!text) {
    await query(`DELETE FROM strategy_review_notes WHERE period_key = $1`, [key])
    return { periodKey: key, note: '', deleted: true }
  }

  await query(
    `INSERT INTO strategy_review_notes (period_key, note, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (period_key) DO UPDATE
       SET note = EXCLUDED.note, updated_at = NOW()`,
    [key, text],
  )
  return { periodKey: key, note: text, deleted: false }
}

export async function upsertStrategyReviewNotesBatch(
  notes: Record<string, string>,
): Promise<number> {
  let n = 0
  for (const [periodKey, note] of Object.entries(notes)) {
    if (!periodKey.trim()) continue
    await upsertStrategyReviewNote(periodKey, note)
    n++
  }
  return n
}
