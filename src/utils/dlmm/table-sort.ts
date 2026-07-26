export type SortDir = 'asc' | 'desc'

/** First click on a column: numeric → desc (high→low); string → asc (A→Z). Same column flips. */
export function toggleSort<K extends string>(
  prevKey: K,
  prevDir: SortDir,
  nextKey: K,
  opts: { numericFirstDesc: boolean },
): { key: K; dir: SortDir } {
  if (prevKey === nextKey) {
    return { key: nextKey, dir: prevDir === 'asc' ? 'desc' : 'asc' }
  }
  const dir: SortDir = opts.numericFirstDesc ? 'desc' : 'asc'
  return { key: nextKey, dir }
}

/** Null/NaN last in both directions. */
export function compareNum(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDir,
): number {
  const aOk = typeof a === 'number' && Number.isFinite(a)
  const bOk = typeof b === 'number' && Number.isFinite(b)
  if (!aOk && !bOk) return 0
  if (!aOk) return 1
  if (!bOk) return -1
  const d = a - b
  return dir === 'asc' ? d : -d
}

/** Case-insensitive; empty last. */
export function compareStr(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir,
): number {
  const as = (a ?? '').trim()
  const bs = (b ?? '').trim()
  if (!as && !bs) return 0
  if (!as) return 1
  if (!bs) return -1
  const d = as.localeCompare(bs, undefined, { sensitivity: 'base' })
  return dir === 'asc' ? d : -d
}

export function sortMarker(active: boolean, dir: SortDir): string {
  if (!active) return ''
  return dir === 'asc' ? ' ↑' : ' ↓'
}
