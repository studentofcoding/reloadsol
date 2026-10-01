import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOSED_LOOP_FEATURE_COLUMNS,
  ENTRY_FEATURE_COLUMNS_V1,
  ENTRY_FEATURE_COLUMNS_V2,
  FEATURE_REGISTRY,
  FEATURE_SCHEMA_VERSION,
  ML_NUMERIC_FEATURE_KEYS,
  ML_SOCIAL_FEATURE_KEYS,
  PATTERN_FEATURE_KEYS,
  serializeSchemaMirror,
  stageColumnSets,
  validateModelSchema,
  type FeatureStage,
} from '@/strategies/feature-registry'

const STAGES: FeatureStage[] = ['entry', 'pattern', 'closed_loop']
const SCHEMA_PATH = path.join(process.cwd(), 'ml', 'feature-schema.json')
const PATTERN_META_PATH = path.join(
  process.cwd(),
  'ml',
  'artifacts',
  'pattern-gate',
  'model.meta.json',
)

describe('feature registry', () => {
  it('declares every stage with non-empty, unique column sets', () => {
    expect(FEATURE_SCHEMA_VERSION).toBeGreaterThan(0)
    expect(FEATURE_REGISTRY.version).toBe(FEATURE_SCHEMA_VERSION)

    for (const stage of STAGES) {
      const sets = stageColumnSets(stage)
      expect(Object.keys(sets).length).toBeGreaterThan(0)
      for (const [name, columns] of Object.entries(sets)) {
        expect(columns.length, `${stage}.${name} empty`).toBeGreaterThan(0)
        expect(new Set(columns).size, `${stage}.${name} has a duplicate key`).toBe(
          columns.length,
        )
      }
    }
  })

  it('keeps the column widths the models and exporters rely on', () => {
    expect(ENTRY_FEATURE_COLUMNS_V1).toHaveLength(12)
    expect(ENTRY_FEATURE_COLUMNS_V2).toHaveLength(17)
    expect(PATTERN_FEATURE_KEYS).toHaveLength(10)
    expect(CLOSED_LOOP_FEATURE_COLUMNS).toHaveLength(13)
    expect(ML_NUMERIC_FEATURE_KEYS).toHaveLength(6)
    expect(ML_SOCIAL_FEATURE_KEYS).toHaveLength(5)
  })
})

describe('schema mirror', () => {
  it('matches the committed ml/feature-schema.json byte-for-byte', () => {
    const onDisk = fs.readFileSync(SCHEMA_PATH, 'utf8')
    expect(serializeSchemaMirror()).toBe(onDisk)
  })

  it('carries the exact lists the Python side derives', () => {
    const mirror = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as {
      version: number
      stages: Record<string, Record<string, string[]>>
    }
    expect(mirror.version).toBe(FEATURE_SCHEMA_VERSION)

    const v1 = mirror.stages.entry!.v1!
    const v2 = mirror.stages.entry!.v2!

    // ml/features.py derives these by partition — pin the result.
    expect(v1.filter((c) => !c.startsWith('band_'))).toEqual([
      'log_entry_mcap',
      'organic_score',
      'top_holders_pct',
      'token_age_hours',
      'log_volume_at_entry',
      'entry_template_milestone_80',
    ])
    expect(v1.filter((c) => c.startsWith('band_'))).toEqual([
      'band_under50k',
      'band_51-100k',
      'band_101-200k',
      'band_201-500k',
      'band_501k-1M',
      'band_over1M',
    ])
    expect(v2.filter((c) => !v1.includes(c))).toEqual([
      'log_telegram_mention_count_30m',
      'telegram_unique_channels_30m',
      'minutes_since_first_mention',
      'smart_wallet_buy_count_1h',
      'has_smart_wallet_buy',
    ])

    // ml/pattern_features.py: the social subset is everything but the mcap column.
    expect(mirror.stages.pattern!.default!.filter((c) => c !== 'log_first_mcap')).toHaveLength(9)
  })
})

describe('validateModelSchema', () => {
  it('accepts a meta whose columns equal a named set', () => {
    for (const stage of STAGES) {
      const sets = stageColumnSets(stage)
      for (const [name, columns] of Object.entries(sets)) {
        const verdict = validateModelSchema({ stage, columns, version: FEATURE_SCHEMA_VERSION })
        expect(verdict.ok, `${stage}.${name} should be accepted`).toBe(true)
        if (verdict.ok) expect(verdict.set).toBe(name)
      }
    }
  })

  it('is order-insensitive because inference is name-keyed', () => {
    const shuffled = [...PATTERN_FEATURE_KEYS].reverse()
    const verdict = validateModelSchema({ stage: 'pattern', columns: shuffled })
    expect(verdict.ok).toBe(true)
  })

  it('refuses a version mismatch and names it', () => {
    const verdict = validateModelSchema({
      stage: 'pattern',
      columns: PATTERN_FEATURE_KEYS,
      version: FEATURE_SCHEMA_VERSION + 1,
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('feature_schema_version')
  })

  it('refuses a column the code does not produce, and names it', () => {
    const verdict = validateModelSchema({
      stage: 'pattern',
      columns: [...PATTERN_FEATURE_KEYS, 'not_a_real_feature'],
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('not_a_real_feature')
  })

  it('refuses an empty or missing column list', () => {
    expect(validateModelSchema({ stage: 'pattern', columns: [] }).ok).toBe(false)
    expect(validateModelSchema({ stage: 'pattern', columns: null }).ok).toBe(false)
  })

  it('refuses the subset the old pattern models declared, naming what is missing', () => {
    const legacySeven = PATTERN_FEATURE_KEYS.slice(0, 7)
    const verdict = validateModelSchema({ stage: 'pattern', columns: legacySeven })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toContain('7 columns')
      expect(verdict.reason).toContain('gmgn_activity_score_60m')
      expect(verdict.reason).toContain('log_gmgn_sm_wallets_60m')
      expect(verdict.reason).toContain('has_gmgn_hot_before_entry')
    }
  })
})

describe('the real in-repo pattern meta', () => {
  it('is refused by name — pinning today’s drift so it cannot silently return', () => {
    const meta = JSON.parse(fs.readFileSync(PATTERN_META_PATH, 'utf8')) as {
      feature_columns: string[]
      feature_schema_version?: number
    }
    expect(meta.feature_columns).toHaveLength(7)

    const verdict = validateModelSchema({
      stage: 'pattern',
      columns: meta.feature_columns,
      version: meta.feature_schema_version ?? null,
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toContain('missing vs default')
      expect(verdict.reason).toContain('has_gmgn_hot_before_entry')
    }
  })
})
