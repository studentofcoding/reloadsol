/**
 * Per-field provenance for config values — T7 of SPEC-config-taxonomy.
 *
 * `stored` and `defaults` render identically on the config page and mean opposite things: the system is
 * using the value you set, versus the system fell back to stock because nothing was set. That
 * distinction cannot be derived in the UI, which is the whole reason this lives here: the two sides are
 * only both in scope inside the loader/route, where the effective config (stored merged over defaults)
 * sits beside the code default it was merged against.
 *
 * Provenance is decided by **key presence in the raw stored config**, not by comparing values. A stored
 * value that happens to equal the default (an operator pinned `tp1_percentage` to today's default so it
 * survives a future default change) is still `stored`; comparing values reported it `defaults`, which
 * is exactly the lie this module exists to prevent. Value comparison remains only as the fallback for
 * callers that have no raw stored config to hand (see `diffSource`'s third argument).
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const has = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

/** The slice of a `strategy_definitions` row this module needs (structural, so no import). */
export interface StoredDefinitionRow {
  id: string
  domain: string
  chain?: string
  name?: string | null
  description?: string | null
  config?: unknown
  is_active?: boolean | null
  execution_mode?: string | null
}

/**
 * Raw stored config per strategy id for one domain: exactly what a row carries, nothing merged in.
 *
 * `name`, `description`, `execution_mode` and `is_active` live in row columns rather than inside
 * `config`, but the merge applies them over the code defaults all the same, so a row that sets them
 * counts as storing them. `is_active` is a NOT NULL column, so any row stores it.
 *
 * `nestConfig` matches the one strategy shape that keeps its thresholds under a `config` key (DLMM)
 * instead of spreading them at the top level: the raw config is then placed under `config`.
 */
export function storedConfigById(
  rows: readonly StoredDefinitionRow[],
  domain: string,
  chain?: string,
  opts?: { nestConfig?: boolean },
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    if (row.domain !== domain) continue
    if (chain && row.chain && row.chain !== chain) continue
    const raw: Record<string, unknown> = isPlainObject(row.config) ? { ...row.config } : {}
    const stored: Record<string, unknown> = opts?.nestConfig ? { config: raw } : raw
    if (row.name) stored.name = row.name
    if (row.description) stored.description = row.description
    if (row.execution_mode) stored.execution_mode = row.execution_mode
    if (typeof row.is_active === 'boolean') stored.is_active = row.is_active
    out[row.id] = stored
  }
  return out
}

/**
 * Which fields of `effective` came from stored config and which are the code default in force.
 *
 * `defaults` decides the shape: it is the code's own declaration of what the config contains, so a key
 * the default has and the effective config lacks is `defaults` (the fallback is what is in force).
 *
 * Third argument `stored` is the raw stored config, same shape as `effective` (see `storedConfigById`):
 *  - **given** (any value, including `null`/`{}` meaning "nothing stored"): a field is `stored` iff its
 *    key is present in `stored`, whatever its value — including a value equal to the default. A key
 *    only `effective` carries and `stored` lacks was not set by anyone, so it is `defaults`.
 *  - **omitted**: the legacy fallback — `stored` iff the value differs from the default. It cannot see a
 *    stored value that equals the default, so prefer passing `stored` whenever the raw config exists.
 *
 * Values are reported flat, `parent.child`, because that is how the page labels them.
 */
export function diffSource(
  effective: unknown,
  defaults: unknown,
  stored?: unknown,
): Record<string, ConfigSource> {
  return walk(effective, defaults, stored, stored !== undefined, '')
}

function walk(
  effective: unknown,
  defaults: unknown,
  stored: unknown,
  byPresence: boolean,
  path: string,
): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {}
  const eff = isPlainObject(effective) ? effective : null
  const def = isPlainObject(defaults) ? defaults : null
  const sto = isPlainObject(stored) ? stored : {}

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
    const effVal = effObj[key]
    if (!(key in defObj)) {
      // No default declares it: legacy callers assume someone put it there; with the raw config we know.
      out[child] = byPresence && !has(sto, key) ? 'defaults' : 'stored'
      continue
    }
    const defVal = defObj[key]
    if (isPlainObject(effVal) && isPlainObject(defVal)) {
      Object.assign(out, walk(effVal, defVal, sto[key], byPresence, child))
      continue
    }
    out[child] = byPresence
      ? has(sto, key)
        ? 'stored'
        : 'defaults'
      : canonical(effVal) === canonical(defVal)
        ? 'defaults'
        : 'stored'
  }

  return out
}
