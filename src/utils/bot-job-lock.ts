import { supabase } from '@/utils/supabase'
import {
  formatSupabaseError,
  isSupabaseCircuitOpen,
  isSupabaseQuotaOrTimeoutError,
} from '@/utils/db-health'

const DEFAULT_TTL_SEC = parseInt(process.env.BOT_JOB_LOCK_TTL_SEC || '600', 10)

/** Prevent overlapping cron/API job runs across server instances. */
export async function acquireJobLock(
  jobName: string,
  ttlSeconds = DEFAULT_TTL_SEC,
): Promise<{ acquired: boolean; reason?: string }> {
  if (isSupabaseCircuitOpen()) {
    return {
      acquired: false,
      reason: 'Supabase circuit open — skipping job until cooldown',
    }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  const lockedBy = `worker-${crypto.randomUUID()}`

  await supabase
    .from('bot_job_locks')
    .delete()
    .lt('expires_at', now.toISOString())

  const { error } = await supabase.from('bot_job_locks').insert({
    job_name: jobName,
    locked_at: now.toISOString(),
    locked_by: lockedBy,
    expires_at: expiresAt,
  })

  if (!error) {
    return { acquired: true }
  }

  if (error.code === '23505') {
    return {
      acquired: false,
      reason: `Job "${jobName}" already running`,
    }
  }

  const reason = formatSupabaseError(error)
  console.warn(`[bot-job-lock] lock insert failed for ${jobName}:`, reason)
  return {
    acquired: false,
    reason: isSupabaseQuotaOrTimeoutError(error)
      ? 'Supabase unavailable (quota/timeout) — job skipped'
      : reason,
  }
}

export async function releaseJobLock(jobName: string): Promise<void> {
  if (isSupabaseCircuitOpen()) return
  await supabase.from('bot_job_locks').delete().eq('job_name', jobName)
}
