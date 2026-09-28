import { describe, expect, it, vi } from 'vitest'
import {
  callTypeSafeNoulQuestion,
  callTypeSafeNoulQuestions,
} from './typesafe-noul'

type FetchInit = { body?: string }

describe('callTypeSafeNoulQuestions', () => {
  it('sends every question in one request and maps answers by id', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => ({
      ok: true,
      json: async () => ({
        model: 'jev-x',
        answers: { a: { noul: 0.8 }, b: { noul: 0.2 } },
      }),
    }))

    const res = await callTypeSafeNoulQuestions(
      { foo: 1 },
      [
        { questionKey: 'a', instructions: 'A?' },
        {
          questionKey: 'b',
          instructions: 'B?',
          criteria: { true: 't', false: 'f' },
        },
      ],
      { apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch },
    )

    expect(res).toMatchObject({ ok: true, answers: { a: 0.8, b: 0.2 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(Object.keys(body.questions)).toEqual(['a', 'b'])
    expect(body.questions.a).toEqual({ type: 'noul', instructions: 'A?' })
    expect(body.questions.b.criteria).toEqual({ true: 't', false: 'f' })
  })

  it('keeps the call ok when one answer is unusable (that id is null)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ answers: { a: { noul: 0.7 } } }),
    }))

    const res = await callTypeSafeNoulQuestions(
      {},
      [
        { questionKey: 'a', instructions: 'A?' },
        { questionKey: 'b', instructions: 'B?' },
      ],
      { apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch },
    )

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.answers).toEqual({ a: 0.7, b: null })
  })

  it('soft-fails without creds and on http error', async () => {
    const noCreds = await callTypeSafeNoulQuestions(
      {},
      [{ questionKey: 'a', instructions: 'A?' }],
      { apiKey: null },
    )
    expect(noCreds).toEqual({ ok: false, reason: 'missing_creds' })

    const httpMock = vi.fn(async () => ({ ok: false }))
    const http = await callTypeSafeNoulQuestions(
      {},
      [{ questionKey: 'a', instructions: 'A?' }],
      { apiKey: 'k', fetchImpl: httpMock as unknown as typeof fetch },
    )
    expect(http).toEqual({ ok: false, reason: 'http' })
  })
})

describe('callTypeSafeNoulQuestion', () => {
  it('returns the single answer as a noul result', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ answers: { a: { noul: 0.42 } } }),
    }))

    const res = await callTypeSafeNoulQuestion(
      {},
      { questionKey: 'a', instructions: 'A?' },
      { apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch },
    )
    expect(res).toEqual({ ok: true, noul: 0.42, model: 'jev-latest' })
  })
})
