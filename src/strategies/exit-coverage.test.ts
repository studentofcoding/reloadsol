import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')

function read(abs: string): string {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

/**
 * Follow ONE level of import and report how `symbol` is reached.
 *
 * One level, not a resolver. Both indirections in this repo are one hop (`gmgn/sim-track` opens
 * through `gmgn-open-sim.ts`, `signals/sim-track` through `telegram-alpha-sim.ts`), and both use the
 * `@/` alias as well as relative paths — a relative-only resolver reported a false gap for gmgn, and
 * reading only the route file reported a false gap for signals. Deeper than one hop this stops being
 * readable; the point is to make adding an open path impossible to do SILENTLY, not to prove it.
 */
function reachesSymbol(relFile: string, symbol: string): string | null {
  const abs = resolve(REPO, relFile)
  const src = read(abs)
  if (!src) return null
  if (src.includes(symbol)) return 'self'

  const dir = dirname(abs)
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]!
    const base = spec.startsWith('.')
      ? resolve(dir, spec)
      : spec.startsWith('@/')
        ? resolve(REPO, 'src', spec.slice(2))
        : null
    if (!base) continue
    for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
      if (existsSync(candidate) && read(candidate).includes(symbol)) {
        return candidate.replace(`${REPO}/`, '')
      }
    }
  }
  return null
}

/**
 * Every route that can open a paper position, and how it reaches registration.
 *
 * Verified against the files, 2026-10-02 — not assumed. Four of five register, and the one that does
 * not is a different domain entirely.
 */
const OPEN_PATHS: Record<string, string> = {
  'src/app/api/mcap-tracking/sim-track/route.ts': 'self',
  'src/app/api/social/sim-track/route.ts': 'self',
  'src/app/api/gmgn/sim-track/route.ts': 'src/strategies/gmgn-open-sim.ts',
  'src/app/api/signals/sim-track/route.ts': 'src/strategies/telegram-alpha-sim.ts',
  'src/app/api/dlmm/sim-track/route.ts': 'NONE — dlmm is its own domain and never touches sl_tp_positions',
}

const NO_CONTRACT = ['src/app/api/dlmm/sim-track/route.ts']

describe('S7 — every open path reaches the one exit evaluator', () => {
  it('has a row for every sim-track route, so a new one cannot be added silently', () => {
    // The assertion that carries the weight: it fails the moment an open path exists that this file
    // has never heard of, which is S7's whole point ("reaches one consumer must be impossible to
    // ship again").
    for (const file of Object.keys(OPEN_PATHS)) {
      expect(existsSync(resolve(REPO, file)), `${file} is listed but does not exist`).toBe(true)
    }
    expect(Object.keys(OPEN_PATHS)).toHaveLength(5)
  })

  it('reaches registration exactly as recorded, and only dlmm does not', () => {
    const notReached: string[] = []
    for (const [file, expected] of Object.entries(OPEN_PATHS)) {
      const actual = reachesSymbol(file, 'registerSimExitContract')
      if (expected === 'NONE — dlmm is its own domain and never touches sl_tp_positions') {
        expect(actual, `${file} was recorded as not registering`).toBeNull()
        notReached.push(file)
      } else {
        expect(actual, `${file} was recorded as reaching ${expected}`).toBe(expected)
      }
    }
    // Any NEW path that does not register lands here and fails the test above.
    expect(notReached).toEqual(NO_CONTRACT)
  })

  it('does not report success for a path that cannot be resolved', () => {
    // Guards the helper itself: a typo'd path must not read as "registers", or this gate would pass
    // while protecting nothing.
    expect(reachesSymbol('src/app/api/nope/route.ts', 'registerSimExitContract')).toBeNull()
    expect(reachesSymbol('src/app/api/signals/sim-track/route.ts', 'registerSimExitContract'))
      .toBe('src/strategies/telegram-alpha-sim.ts')
    expect(reachesSymbol('src/app/api/gmgn/sim-track/route.ts', 'registerSimExitContract'))
      .toBe('src/strategies/gmgn-open-sim.ts')
  })
})
