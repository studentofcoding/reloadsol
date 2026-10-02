import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchJupiterSwapQuote, JupiterSwapQuoteError } from '@/utils/jupiter-swap-quote'
import type { JupiterSwapQuoteParams } from '@/utils/jupiter-swap-quote'

const params: JupiterSwapQuoteParams = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP',
  amount: '5000000',
} as JupiterSwapQuoteParams

afterEach(() => vi.unstubAllGlobals())

/**
 * The server marks a venue refusal with 422 and `venueRefused`. That flag cannot cross the HTTP
 * boundary, so the browser fetcher must reconstruct it from the status — otherwise `prepareDeskSwap`
 * misses the refusal and falls back to Lite, which cannot simulate and would build a tx the wallet
 * cannot pay for. Measured live 2026-10-02: "Jupiter refused the order: Insufficient funds" arriving
 * as a plain failure and falling through to Lite.
 */
describe('fetchJupiterSwapQuote — venue refusal across the proxy', () => {
  it('reconstructs venueRefused from a 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({ error: 'Jupiter refused the order: Insufficient funds' }),
      })),
    )
    const err = await fetchJupiterSwapQuote(params).catch((e) => e)
    expect(err).toBeInstanceOf(JupiterSwapQuoteError)
    expect((err as JupiterSwapQuoteError).venueRefused).toBe(true)
  })

  it('does NOT mark a genuine transport fault as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, text: async () => '{"error":"boom"}' })),
    )
    const err = await fetchJupiterSwapQuote(params).catch((e) => e)
    expect((err as JupiterSwapQuoteError).venueRefused).toBeFalsy()
  })
})
