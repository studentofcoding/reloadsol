/**
 * Write the committed Python mirror of the feature registry.
 *
 * `ml/feature-schema.json` is the contract the Python side reads, so it is committed rather than
 * built — prod must never depend on a build ordering to have a schema. Run after any registry edit:
 *
 *   npm run ml:export-schema
 *
 * Idempotent: a second run produces no diff.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildSchemaMirror,
  serializeSchemaMirror,
} from '../src/strategies/feature-registry'

const outPath = path.join(process.cwd(), 'ml', 'feature-schema.json')

const mirror = buildSchemaMirror()
const stages = Object.keys(mirror.stages)
const columns = stages.reduce(
  (sum, stage) =>
    sum +
    Object.values(mirror.stages[stage] ?? {}).reduce(
      (n, cols) => n + cols.length,
      0,
    ),
  0,
)

fs.writeFileSync(outPath, serializeSchemaMirror(), 'utf8')
console.log(
  `[export-feature-schema] wrote ${path.relative(process.cwd(), outPath)} — ` +
    `v${mirror.version}, ${stages.length} stages, ${columns} columns`,
)
