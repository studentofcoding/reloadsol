const PLACEHOLDER_HOSTS = [
  'your-project.supabase.co',
  'placeholder.supabase.co',
  'example.supabase.co',
];

export function getSupabaseHost(): string | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return false;
  if (key === 'your-secret-key' || key === 'placeholder-key') return false;
  if (key.startsWith('PASTE_')) return false;
  const host = getSupabaseHost();
  if (!host) return false;
  return !PLACEHOLDER_HOSTS.some((p) => host === p || host.includes('your-project'));
}

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
    combined.includes('aborted')
  );
}

/** Supabase free-tier egress exceeded or origin timeout (Cloudflare 522 HTML). */
export function isSupabaseQuotaOrTimeoutError(error: unknown): boolean {
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

/** Short log-safe message — never dump Cloudflare HTML pages. */
export function formatSupabaseError(error: unknown): string {
  if (isSupabaseQuotaOrTimeoutError(error)) {
    return 'Supabase unreachable (522/timeout — check Dashboard egress quota and project status)';
  }
  if (isDbConnectivityError(error)) {
    const host = getSupabaseHost() ?? 'unknown host';
    return `Supabase unreachable (${host})`;
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

let supabaseCircuitOpenUntil = 0;
const SUPABASE_CIRCUIT_COOLDOWN_MS = parseInt(
  process.env.SUPABASE_CIRCUIT_COOLDOWN_MS || '60000',
  10,
);

export function isSupabaseCircuitOpen(): boolean {
  return Date.now() < supabaseCircuitOpenUntil;
}

export function recordSupabaseFailure(): void {
  supabaseCircuitOpenUntil = Date.now() + SUPABASE_CIRCUIT_COOLDOWN_MS;
}

export function recordSupabaseSuccess(): void {
  supabaseCircuitOpenUntil = 0;
}

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
    const host = getSupabaseHost() ?? 'unknown host';
    return `Supabase unreachable (${host}). Set valid SUPABASE_URL and SUPABASE_SECRET_KEY in .env, then apply supabase/schema.sql.`;
  }

  if (isMissingSchemaError(error)) {
    return 'DLMM tables missing. Run supabase/schema.sql in your Supabase SQL editor.';
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
    super(message ?? formatDbError(new Error('fetch failed')));
    this.name = 'DbUnavailableError';
  }
}

export function assertDbWritable(error: unknown): never {
  throw new DbUnavailableError(formatDbError(error));
}
