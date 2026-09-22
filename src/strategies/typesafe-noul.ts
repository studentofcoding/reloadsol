/**
 * Thin TypeSafe System One Noul client for Early Enter shadow.
 * Uses TYPESAFE_API_KEY from env (ops #56). Missing creds / timeout → caller
 * maps to api_miss soft-fail → SPEC. Never invent secrets in-repo.
 *
 * Soft-fail is NOT "low confidence" — Noul has no confidence field.
 */

import type { EarlyEnterNoulState } from './early-enter-noul-shadow'

const DEFAULT_BASE = 'https://api.typesafe.ai/v1'
const DEFAULT_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 2500

export type TypeSafeNoulCallResult =
  | { ok: true; noul: number; model: string | null }
  | { ok: false; reason: 'missing_creds' | 'timeout' | 'http' | 'parse' | 'exception' }

export function getTypeSafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = env.TYPESAFE_API_KEY?.trim()
  return key ? key : null
}

export function getTypeSafeBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.TYPESAFE_BASE_URL?.trim()
  if (!raw) return DEFAULT_BASE
  return raw.replace(/\/$/, '')
}

export function getTypeSafeModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULT_MODEL
}

export function getTypeSafeNoulTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.EARLY_ENTER_NOUL_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

const NOUL_QUESTION_KEY = 'early_enter_keep'

/** Instructions for keep/suppress judgment beside Early Enter soft gate. */
export const EARLY_ENTER_NOUL_INSTRUCTIONS =
  'Should we keep (emit) this Early Enter toast/Telegram alert given the closed-loop ML score and soft-gate settings in state? Answer yes to keep/emit, no to suppress.'

export async function callTypeSafeNoul(
  state: EarlyEnterNoulState,
  opts?: {
    apiKey?: string | null
    baseUrl?: string
    model?: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
  },
): Promise<TypeSafeNoulCallResult> {
  const apiKey = opts?.apiKey !== undefined ? opts.apiKey : getTypeSafeApiKey()
  if (!apiKey) return { ok: false, reason: 'missing_creds' }

  const baseUrl = opts?.baseUrl ?? getTypeSafeBaseUrl()
  const model = opts?.model ?? getTypeSafeModel()
  const timeoutMs = opts?.timeoutMs ?? getTypeSafeNoulTimeoutMs()
  const fetchImpl = opts?.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(`${baseUrl}/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        state,
        questions: {
          [NOUL_QUESTION_KEY]: {
            type: 'noul',
            instructions: EARLY_ENTER_NOUL_INSTRUCTIONS,
            criteria: {
              true: 'Keep / emit the Early Enter toast and Telegram alert',
              false: 'Suppress the Early Enter toast and Telegram alert',
            },
          },
        },
      }),
      signal: controller.signal,
    })

    if (!res.ok) return { ok: false, reason: 'http' }

    const json = (await res.json()) as {
      model?: string
      answers?: Record<string, { type?: string; noul?: number }>
    }
    const answer = json.answers?.[NOUL_QUESTION_KEY]
    const noul = answer?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      return { ok: false, reason: 'parse' }
    }
    return { ok: true, noul, model: json.model ?? model }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' }
    }
    return { ok: false, reason: 'exception' }
  } finally {
    clearTimeout(timer)
  }
}
