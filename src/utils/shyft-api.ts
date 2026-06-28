import {
  shyftRateLimitDelayMs,
  waitForShyftRateLimit,
} from '@/utils/shyft-rate-limit'

export const SHYFT_API_BASE = 'https://api.shyft.to'

export class ShyftAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message)
    this.name = 'ShyftAPIError'
  }
}

export type ShyftApiResponse<T> = {
  success: boolean
  message?: string
  result: T
}

export function getShyftApiKey(): string | null {
  const key = process.env.SHYFT_API_KEY?.trim()
  if (!key || key === 'your-shyft-api-key') {
    return null
  }
  return key
}

export function requireShyftApiKey(): string {
  const key = getShyftApiKey()
  if (!key) {
    throw new ShyftAPIError(
      'SHYFT_API_KEY not configured. Set it in .env (https://shyft.to dashboard).',
      503,
    )
  }
  return key
}

async function shyftFetchOnce<T>(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ result: T; latencyMs: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    })

    const bodyText = await response.text().catch(() => '')

    if (!response.ok) {
      throw new ShyftAPIError(
        `Shyft API failed (${response.status}): ${bodyText.slice(0, 200)}`,
        response.status,
      )
    }

    let data: ShyftApiResponse<T>
    try {
      data = JSON.parse(bodyText) as ShyftApiResponse<T>
    } catch {
      throw new ShyftAPIError(
        `Shyft API returned invalid JSON: ${bodyText.slice(0, 200)}`,
        response.status,
      )
    }

    if (!data.success) {
      throw new ShyftAPIError(
        data.message ?? 'Shyft API request failed',
        response.status,
      )
    }

    return {
      result: data.result,
      latencyMs: Date.now() - start,
    }
  } catch (error) {
    if (error instanceof ShyftAPIError) {
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ShyftAPIError(`Shyft API timed out after ${timeoutMs}ms`, 504)
    }
    throw new ShyftAPIError(
      error instanceof Error ? error.message : 'Unknown Shyft API error',
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function shyftFetch<T>(
  path: string,
  params: Record<string, string>,
  options?: { apiKey?: string; timeoutMs?: number },
): Promise<{ result: T; latencyMs: number }> {
  const apiKey = options?.apiKey ?? requireShyftApiKey()
  const timeoutMs = options?.timeoutMs ?? 15_000

  const url = new URL(path, SHYFT_API_BASE)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const maxAttempts = 3
  let lastError: ShyftAPIError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await waitForShyftRateLimit()
    try {
      return await shyftFetchOnce<T>(url.toString(), apiKey, timeoutMs)
    } catch (error) {
      if (!(error instanceof ShyftAPIError)) {
        throw error
      }
      lastError = error
      if (error.statusCode === 429 && attempt < maxAttempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, shyftRateLimitDelayMs(attempt)),
        )
        continue
      }
      throw error
    }
  }

  throw lastError ?? new ShyftAPIError('Shyft API request failed')
}
