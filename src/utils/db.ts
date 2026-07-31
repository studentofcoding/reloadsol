import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// Postgres NUMERIC (OID 1700) → JS number for API/UI .toFixed() etc.
types.setTypeParser(1700, (val) => parseFloat(val));
import {
  isDbCircuitOpen,
  isDbConnectivityError,
  recordDbFailure,
  recordDbSuccess,
} from './db-health';

let pool: Pool | null = null;

const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || '10', 10);

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error('DATABASE_URL must be set');
    }
    pool = new Pool({
      connectionString: url,
      max: POOL_MAX,
      // ponytail: PgBouncer transaction pool rejects prepared statements
      prepare: false,
    } as ConstructorParameters<typeof Pool>[0]);
  }
  return pool;
}

export type QueryOptions = { bypassCircuit?: boolean };

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
  opts?: QueryOptions,
): Promise<{ rows: T[]; rowCount: number }> {
  if (!opts?.bypassCircuit && isDbCircuitOpen()) {
    throw new TypeError('Database circuit open (recent failures)');
  }
  try {
    const result = await getPool().query<T>(sql, params);
    recordDbSuccess();
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    if (isDbConnectivityError(error)) {
      recordDbFailure();
    }
    throw error;
  }
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
  opts?: QueryOptions,
): Promise<T | null> {
  const { rows } = await query<T>(sql, params, opts);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (isDbCircuitOpen()) {
    throw new TypeError('Database circuit open (recent failures)');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    recordDbSuccess();
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (isDbConnectivityError(error)) {
      recordDbFailure();
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Run query on a transaction client (for withTransaction callbacks). */
export async function clientQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await client.query<T>(sql, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// REL-20: batched writes via INSERT/UPDATE ... FROM UNNEST (single round-trip)
// ---------------------------------------------------------------------------

/** A column participating in a bulk write; `type` is the Postgres cast. */
export interface BulkColumn {
  name: string;
  /** Postgres type cast used in UNNEST, e.g. 'text', 'float8', 'jsonb', 'timestamptz'. */
  type: string;
}

export interface BulkWriteStats {
  rows: number;
  chunks: number;
  ms: number;
}

/** Bound per-statement parameter counts on large batches. */
export const BULK_WRITE_CHUNK_ROWS = 500;

function unnestSelect(columns: BulkColumn[], paramOffset = 0): string {
  const params = columns
    .map((c, i) => `$${paramOffset + i + 1}::${c.type}[]`)
    .join(', ');
  const aliases = columns.map((c) => c.name).join(', ');
  return `SELECT * FROM UNNEST(${params}) AS v(${aliases})`;
}

/**
 * Bulk INSERT (optionally UPSERT) from JS arrays — node-pg sends each array
 * column as a native PG array, one statement per chunk.
 * `rows` is an array of tuples aligned with `columns` order.
 */
export async function bulkInsert(opts: {
  table: string;
  columns: BulkColumn[];
  rows: unknown[][];
  /** e.g. '(token_address)' — when set, ON CONFLICT is emitted. */
  conflictTarget?: string;
  /** Columns set to EXCLUDED.<col> on conflict. Omit (with conflictTarget) for DO NOTHING. */
  updateColumns?: string[];
  /** Extra SET expressions on conflict, e.g. ['updated_at = NOW()']. */
  extraSet?: string[];
  chunkRows?: number;
}): Promise<BulkWriteStats> {
  const { table, columns, rows, conflictTarget, updateColumns, extraSet } = opts;
  const chunkRows = opts.chunkRows ?? BULK_WRITE_CHUNK_ROWS;
  if (rows.length === 0) return { rows: 0, chunks: 0, ms: 0 };

  const colNames = columns.map((c) => c.name).join(', ');
  let conflict = '';
  if (conflictTarget) {
    if (updateColumns && updateColumns.length > 0) {
      const sets = [
        ...updateColumns.map((c) => `${c} = EXCLUDED.${c}`),
        ...(extraSet ?? []),
      ].join(', ');
      conflict = ` ON CONFLICT ${conflictTarget} DO UPDATE SET ${sets}`;
    } else {
      conflict = ` ON CONFLICT ${conflictTarget} DO NOTHING`;
    }
  }

  const sql = `INSERT INTO ${table} (${colNames}) ${unnestSelect(columns)}${conflict}`;

  const start = Date.now();
  let chunks = 0;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const chunk = rows.slice(i, i + chunkRows);
    const params = columns.map((_, ci) => chunk.map((r) => r[ci]));
    await query(sql, params);
    chunks++;
  }
  return { rows: rows.length, chunks, ms: Date.now() - start };
}

/**
 * Bulk UPDATE keyed by a single column:
 * UPDATE t SET ... FROM (SELECT * FROM UNNEST(...)) v WHERE t.key = v.key
 * `rows` tuples are [...setColumnValues, keyValue] (key LAST).
 */
export async function bulkUpdateByKey(opts: {
  table: string;
  key: BulkColumn;
  /** SET columns, in tuple order (before the key). */
  columns: BulkColumn[];
  rows: unknown[][];
  /** Extra SET expressions, e.g. ['updated_at = NOW()']. */
  extraSet?: string[];
  chunkRows?: number;
}): Promise<BulkWriteStats> {
  const { table, key, columns, rows, extraSet } = opts;
  const chunkRows = opts.chunkRows ?? BULK_WRITE_CHUNK_ROWS;
  if (rows.length === 0) return { rows: 0, chunks: 0, ms: 0 };

  const all = [...columns, key];
  const sets = [
    ...columns.map((c) => `${c.name} = v.${c.name}`),
    ...(extraSet ?? []),
  ].join(', ');
  const sql = `UPDATE ${table} AS t SET ${sets} FROM (${unnestSelect(all)}) AS v WHERE t.${key.name} = v.${key.name}`;

  const start = Date.now();
  let chunks = 0;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const chunk = rows.slice(i, i + chunkRows);
    const params = all.map((_, ci) => chunk.map((r) => r[ci]));
    await query(sql, params);
    chunks++;
  }
  return { rows: rows.length, chunks, ms: Date.now() - start };
}

/** Per-row hooks for collected batch writes. */
export interface BatchRowHooks {
  /** Runs after the batch statement succeeds (e.g. notifications). */
  after?: () => Promise<void> | void;
  /** Runs when the batch statement fails (e.g. per-token error logging). */
  onError?: (error: unknown) => void;
}

/**
 * Collects row tuples during a loop and flushes them as one batched statement
 * (or a few chunks). Preserves per-row side effects via hooks: `after` hooks
 * run only on success, `onError` hooks run on failure — mirroring the old
 * per-row await semantics.
 */
export class WriteBatch {
  private entries: { values: unknown[]; hooks?: BatchRowHooks }[] = [];

  constructor(
    public readonly name: string,
    private readonly flushRows: (rows: unknown[][]) => Promise<BulkWriteStats>,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  add(values: unknown[], hooks?: BatchRowHooks): void {
    this.entries.push({ values, hooks });
  }

  /**
   * Flush collected rows. Resolves ok=false (and fires onError hooks) instead
   * of throwing so callers can mirror Promise.allSettled-style accounting.
   */
  async flush(): Promise<{ stats: BulkWriteStats; ok: boolean; error?: unknown }> {
    const entries = this.entries;
    if (entries.length === 0) return { stats: { rows: 0, chunks: 0, ms: 0 }, ok: true };
    this.entries = [];
    try {
      const stats = await this.flushRows(entries.map((e) => e.values));
      for (const e of entries) await e.hooks?.after?.();
      return { stats, ok: true };
    } catch (error) {
      for (const e of entries) e.hooks?.onError?.(error);
      return {
        stats: { rows: entries.length, chunks: 0, ms: 0 },
        ok: false,
        error,
      };
    }
  }
}
