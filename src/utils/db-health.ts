const PLACEHOLDER_PASSWORDS = new Set([
  'change-me',
  'your-secret-key',
  'placeholder-key',
  'supersecretpassword',
]);

export function getDbHost(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isDbConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const password = parsed.password;
    if (!password || PLACEHOLDER_PASSWORDS.has(password)) return false;
    if (password.startsWith('PASTE_')) return false;
    const host = parsed.hostname;
    if (!host || host === 'placeholder') return false;
    return true;
  } catch {
    return false;
  }
}

/** @deprecated use isDbConfigured */
export const isSupabaseConfigured = isDbConfigured;

/** @deprecated use getDbHost */
export const getSupabaseHost = getDbHost;

export function isDbConnectivityError(error: unknown): boolean {
  const combined = errorTextParts(error);
  return (
    combined.includes('fetch failed') ||
    combined.includes('enotfound') ||
    combined.includes('econnrefused') ||
    combined.includes('etimedout') ||
    combined.includes('network') ||
    combined.includes('getaddrinfo') ||
    combined.includes('failed to fetch') ||
    combined.includes('522') ||
    combined.includes('connection timed out') ||
    combined.includes('circuit open') ||
    combined.includes('aborted') ||
    combined.includes('connect econnrefused') ||
    combined.includes('connection terminated') ||
    combined.includes('password authentication failed') ||
    combined.includes('too many clients') ||
    combined.includes('53300')
  );
}

export function isDbQuotaOrTimeoutError(error: unknown): boolean {
  const combined = errorTextParts(error);
  return (
    combined.includes('522') ||
    combined.includes('connection timed out') ||
    combined.includes('quota') ||
    combined.includes('egress') ||
    combined.includes('exceeded') ||
    combined.includes('rate limit') ||
    combined.includes('<!doctype html') ||
    combined.includes('<html')
  );
}

/** @deprecated use isDbQuotaOrTimeoutError */
export const isSupabaseQuotaOrTimeoutError = isDbQuotaOrTimeoutError;

export function formatDbConnectionError(error: unknown): string {
  if (isDbQuotaOrTimeoutError(error)) {
    return 'Database unreachable (timeout — check Postgres and PgBouncer status)';
  }
  if (isDbConnectivityError(error)) {
    const host = getDbHost() ?? 'unknown host';
    return `Database unreachable (${host})`;
  }
  if (error instanceof Error && error.message) {
    const msg = error.message.trim();
    if (msg.length > 240) return `${msg.slice(0, 240)}…`;
    return msg;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) {
      const msg = e.message.trim();
      if (msg.length > 240) return `${msg.slice(0, 240)}…`;
      return msg;
    }
  }
  return 'Database error';
}

/** @deprecated use formatDbConnectionError */
export const formatSupabaseError = formatDbConnectionError;

let dbCircuitOpenUntil = 0;
const DB_CIRCUIT_COOLDOWN_MS = parseInt(
  process.env.DATABASE_CIRCUIT_COOLDOWN_MS ||
    process.env.SUPABASE_CIRCUIT_COOLDOWN_MS ||
    '60000',
  10,
);

export function isDbCircuitOpen(): boolean {
  return Date.now() < dbCircuitOpenUntil;
}

/** @deprecated use isDbCircuitOpen */
export const isSupabaseCircuitOpen = isDbCircuitOpen;

export function recordDbFailure(): void {
  dbCircuitOpenUntil = Date.now() + DB_CIRCUIT_COOLDOWN_MS;
}

/** @deprecated use recordDbFailure */
export const recordSupabaseFailure = recordDbFailure;

export function recordDbSuccess(): void {
  dbCircuitOpenUntil = 0;
}

/** @deprecated use recordDbSuccess */
export const recordSupabaseSuccess = recordDbSuccess;

function errorTextParts(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message, error.name);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(cause.message);
  } else if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.details === 'string') parts.push(e.details);
    if (typeof e.hint === 'string') parts.push(e.hint);
    if (typeof e.code === 'string') parts.push(e.code);
  } else {
    parts.push(String(error));
  }
  return parts.join(' ').toLowerCase();
}

export function isMissingSchemaError(error: unknown): boolean {
  const combined = errorTextParts(error);
  return (
    combined.includes('does not exist') ||
    combined.includes('relation') ||
    combined.includes('pgrst205') ||
    combined.includes('42p01')
  );
}

export function formatDbError(error: unknown): string {
  if (isDbConnectivityError(error)) {
    const host = getDbHost() ?? 'unknown host';
    return `Database unreachable (${host}). Set DATABASE_URL in .env and apply db/init schema.`;
  }

  if (isMissingSchemaError(error)) {
    return 'DLMM tables missing. Run db/init/02-schema.sql (or supabase/schema.sql).';
  }

  if (error instanceof Error && error.message) return error.message;

  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.details === 'string' && e.details) return e.details;
  }

  return 'Database error';
}

export class DbUnavailableError extends Error {
  readonly status = 503;

  constructor(message?: string) {
    super(message ?? formatDbError(new Error('connection refused')));
    this.name = 'DbUnavailableError';
  }
}

export function assertDbWritable(error: unknown): never {
  throw new DbUnavailableError(formatDbError(error));
}
