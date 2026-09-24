import type { EnvLike } from './env-like'

/**
 * Early Enter toast/Telegram soft gate (closed-loop mlScore only).
 * Pure helpers — no model I/O. Pattern pWinner is display-only.
 */

export const DEFAULT_EARLY_ENTER_ML_MIN = 0.55

function parseOnOffEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

/** Default on. `0` / `false` restores pre-SPEC emit (no closed-loop cut). */
export function isEarlyEnterMlSoftGateEnabled(
  env: EnvLike = process.env,
): boolean {
  return parseOnOffEnv(env.EARLY_ENTER_ML_SOFT_GATE, true)
}

export function getEarlyEnterMlMin(
  env: EnvLike = process.env,
): number {
  const raw = env.EARLY_ENTER_ML_MIN?.trim()
  if (!raw) return DEFAULT_EARLY_ENTER_ML_MIN
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_EARLY_ENTER_ML_MIN
}

/**
 * When disabled, always pass (legacy Stage-1 emit).
 * When enabled, require a finite closed-loop mlScore ≥ min (default 0.55).
 * null / non-finite → unavailable → suppress.
 */
export function passesEarlyEnterMlSoftGate(
  mlScore: number | null | undefined,
  opts?: { min?: number; enabled?: boolean },
): boolean {
  if (!(opts?.enabled ?? true)) return true
  const min = opts?.min ?? DEFAULT_EARLY_ENTER_ML_MIN
  return mlScore != null && Number.isFinite(mlScore) && mlScore >= min
}
