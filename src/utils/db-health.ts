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
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  if (key === 'your-anon-key' || key === 'placeholder-key') return false;
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
    combined.includes('failed to fetch')
  );
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
    return `Supabase unreachable (${host}). Set valid SUPABASE_URL and SUPABASE_ANON_KEY in .env, then apply supabase/schema.sql.`;
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
