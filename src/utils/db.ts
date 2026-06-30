import { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  isDbCircuitOpen,
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
    recordDbFailure();
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
    recordDbFailure();
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
