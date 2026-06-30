import { query } from '@/utils/db';
import {
  formatDbError,
  getDbHost,
  isDbConfigured,
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

  const host = getDbHost();

  if (!isDbConfigured()) {
    const value: DlmmDbStatus = {
      configured: false,
      reachable: false,
      schemaReady: false,
      host,
      error:
        'Database not configured. Set DATABASE_URL in .env (see .env.docker.example).',
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  }

  try {
    await query(`SELECT id FROM dlmm_agent_config LIMIT 1`);

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
