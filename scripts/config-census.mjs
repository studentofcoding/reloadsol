#!/usr/bin/env node
/**
 * Config census — does every config field have a reader?
 *
 * SPEC-config-taxonomy-v1 T1, and the rule that keeps the config surface honest: ~300 editable fields
 * with nothing anywhere able to say which of them anything consumes is how `brain_stop_loss_pct` gets
 * written on 726 rows and never applied. This produces the list, and the SPEC requires it before and
 * after every later slice.
 *
 * **The key set is the exported config types in `src/strategies/types.ts`** — the typed contract every
 * strategy's config satisfies, so it is the surface the UI renders and the savers write. (A previous
 * attempt anchored on `merge-strategy-config-patch.ts` and reported the function's *parameters* — a
 * census that lies is worse than none, which is why this reads the types and reports its own key count.)
 *
 * Buckets:
 *   NO_READER  — declared and referenced nowhere outside its own type: a control nothing touches
 *   UI_ONLY    — referenced only by components: it round-trips through the page, nothing applies it
 *   READ       — some non-test, non-doc file outside the types references it
 *
 * Caveat, stated because it matters: a generic field name (`limit`, `score`) matches many files, so
 * READ over-counts. NO_READER does not — it is the bucket to act on, and it is exact.
 *
 * Run: `node scripts/config-census.mjs [--json] [--only-dull]`
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TYPES = 'src/strategies/types.ts'

/** Exported config types and their top-level field names, read from the source. */
function configFields() {
  const src = readFileSync(resolve(ROOT, TYPES), 'utf8')
  const lines = src.split('\n')
  const out = []
  let current = null
  for (const line of lines) {
    const open = line.match(/^export (?:type|interface) ([A-Za-z]*Config[A-Za-z]*)\b/)
    if (open) {
      current = { name: open[1], fields: [] }
      out.push(current)
      continue
    }
    if (current) {
      // A top-level declaration ends the block; two-space indentation is a field of it.
      if (/^(export |const |function )/.test(line)) {
        current = null
        continue
      }
      const field = line.match(/^\s{2}([a-zA-Z_][A-Za-z0-9_]*)\s*[?:]/)
      if (field) current.fields.push(field[1])
    }
  }
  return out
}

/** Files referencing a token, minus noise that would make every field look read. */
function references(token) {
  let out = ''
  try {
    out = execSync(`git grep -l --fixed-strings -- "${token}"`, { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => f !== TYPES) // its own declaration is not a reader
    .filter((f) => !f.startsWith('db/'))
    .filter((f) => !/(\.test\.|\.spec\.|__tests__)/.test(f))
    .filter((f) => !f.endsWith('.md'))
}

const isUi = (f) => /^src\/components\//.test(f)

function main() {
  const types = configFields()
  const rows = []
  for (const t of types) {
    for (const field of t.fields) {
      const files = references(field)
      const appFiles = files.filter((f) => !isUi(f))
      const bucket = appFiles.length > 0 ? 'READ' : files.length > 0 ? 'UI_ONLY' : 'NO_READER'
      rows.push({ type: t.name, field, bucket, app: appFiles.length, ui: files.filter(isUi).length })
    }
  }

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { types: types.length, fields: rows.length, byType: types.map((t) => ({ name: t.name, fields: t.fields.length })), rows },
        null,
        2,
      ),
    )
    return
  }

  console.log(`config census — ${rows.length} fields across ${types.length} config types in ${TYPES}\n`)
  console.log('by type: ' + types.map((t) => `${t.name}(${t.fields.length})`).join(' · ') + '\n')

  for (const [bucket, note] of [
    ['NO_READER', 'declared and referenced nowhere outside its own type'],
    ['UI_ONLY', 'referenced only by components — rendered, never applied'],
  ]) {
    const list = rows.filter((r) => r.bucket === bucket)
    console.log(`${bucket} — ${list.length}  (${note})`)
    for (const r of list) console.log(`  ${r.type}.${r.field}`)
    if (list.length === 0) console.log('  (none)')
    console.log('')
  }

  const read = rows.filter((r) => r.bucket === 'READ')
  console.log(`READ — ${read.length}  (over-counts: a generic name like \`score\` matches many files)`)
  if (process.argv.includes('--only-dull')) return
  for (const r of read.filter((r) => r.app <= 1).slice(0, 40)) {
    console.log(`  ${r.type}.${r.field}  <- ${r.app} file${r.app === 1 ? '' : 's'}`)
  }
  console.log('\nNO_READER is the bucket to act on, and it is exact. LIVE is not proof of applied:')
  console.log('a field can be read yet inert, which is only provable by reading its reader.')
}

main()
