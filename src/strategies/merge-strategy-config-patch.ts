/** Deep-merge strategy_definitions.config patches (2 levels of nesting). */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * When PATCH omits `config`, keep the existing DB override.
 * When PATCH sends a partial `config`, merge onto existing so sibling keys are not wiped.
 */
export function mergeStrategyConfigPatch(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {}
  if (patch === undefined) return base
  if (!isPlainObject(patch)) return base

  const out: Record<string, unknown> = { ...base, ...patch }

  for (const [key, value] of Object.entries(patch)) {
    if (!isPlainObject(value)) continue
    const prev = isPlainObject(base[key]) ? { ...base[key] } : {}
    const nested: Record<string, unknown> = { ...prev, ...value }
    for (const [nestedKey, nestedVal] of Object.entries(value)) {
      if (!isPlainObject(nestedVal)) continue
      const prevNested = isPlainObject(prev[nestedKey])
        ? { ...prev[nestedKey] }
        : {}
      nested[nestedKey] = { ...prevNested, ...nestedVal }
    }
    out[key] = nested
  }

  return out
}
