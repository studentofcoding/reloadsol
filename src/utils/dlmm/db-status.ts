import { supabase } from '@/utils/supabase';
import {
  formatDbError,
  isSupabaseConfigured,
} from '@/utils/db-health';

export interface DlmmDbStatus {
  configured: boolean;
  reachable: boolean;
  schemaReady: boolean;
  error?: string;
  host?: string | null;
}

let cachedStatus: { at: number; value: DlmmDbStatus } | null = null;
const CACHE_MS = 30_000;

export async function getDlmmDbStatus(force = false): Promise<DlmmDbStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < CACHE_MS) {
    return cachedStatus.value;
  }

  const host = process.env.SUPABASE_URL
    ? (() => {
        try {
          return new URL(process.env.SUPABASE_URL!).hostname;
        } catch {
          return null;
        }
      })()
    : null;

  if (!isSupabaseConfigured()) {
    const value: DlmmDbStatus = {
      configured: false,
      reachable: false,
      schemaReady: false,
      host,
      error:
        'Supabase not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env (see .env.docker.example).',
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  }

  try {
    const { error } = await supabase
      .from('dlmm_agent_config')
      .select('id')
      .limit(1);

    if (error) throw error;

    const value: DlmmDbStatus = {
      configured: true,
      reachable: true,
      schemaReady: true,
      host,
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  } catch (error) {
    const message = formatDbError(error);
    const value: DlmmDbStatus = {
      configured: true,
      reachable: !message.toLowerCase().includes('unreachable'),
      schemaReady: false,
      host,
      error: message,
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  }
}

export function clearDlmmDbStatusCache() {
  cachedStatus = null;
}
