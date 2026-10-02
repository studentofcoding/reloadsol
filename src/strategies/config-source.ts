/**
 * Per-field provenance for config values — T7 of SPEC-config-taxonomy.
 *
 * `stored` and `defaults` render identically on the config page and mean opposite things: the system is
 * using the value you set, versus the system fell back to stock because nothing was set. That
 * distinction cannot be derived in the UI, which is the whole reason this lives here: the two sides are
 * only both in scope inside the loader/route, where the effective config (stored merged over defaults)
 * sits beside the code default it was merged against.
 *
 * Pure, synchronous and dependency-free — it is called per request to decorate a payload, so it must
 * never be able to throw or reach for anything.
 */
export type ConfigSource = 'stored' | 'defaults'

/** Stable comparison that does not care about key order, which JSON.stringify alone would. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`
}

/**
 * Which fields of `effective` differ from `defaults`.
 *
 * `defaults` decides the shape: it is the code's own declaration of what the config contains, so a key
 * the stored config carries and the default does not is reported `stored` (someone put it there), and a
 * key the default has and the stored config lacks is `defaults` (the fallback is what is in force).
 *
 * Values are reported flat, `parent.child`, because that is how the page labels them.
 */
export function diffSource(
  effective: unknown,
  defaults: unknown,
  path = '',
): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {}
  const asObject = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

  const eff = asObject(effective)
  const def = asObject(defaults)

  // Only a genuine leaf (neither side an object) is compared whole. A null side is *not* a leaf: it
  // reads as an empty object, so a null effective config against a populated default reports the
  // default in force rather than reporting nothing — a silent empty result is the failure mode this
  // exists to prevent.
  if (!eff && !def) {
    if (path) out[path] = canonical(effective) === canonical(defaults) ? 'defaults' : 'stored'
    return out
  }

  const effObj = eff ?? {}
  const defObj = def ?? {}
  const keys = new Set([...Object.keys(defObj), ...Object.keys(effObj)])

  for (const key of keys) {
    const child = path ? `${path}.${key}` : key
    if (!(key in effObj)) {
      // Present in the default, absent from what is in force: the fallback is doing the work.
      out[child] = 'defaults'
      continue
    }
    if (!(key in defObj)) {
      out[child] = 'stored'
      continue
    }
    const effVal = effObj[key]
    const defVal = defObj[key]
    if (asObject(effVal) && asObject(defVal)) {
      Object.assign(out, diffSource(effVal, defVal, child))
      continue
    }
    out[child] = canonical(effVal) === canonical(defVal) ? 'defaults' : 'stored'
  }

  return out
}
