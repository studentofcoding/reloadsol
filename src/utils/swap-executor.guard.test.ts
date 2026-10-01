import { describe, expect, it, vi } from 'vitest'
import { dropRevertingPreparedSwaps } from '@/utils/swap-executor'

/**
 * Measured on prod 2026-10-02: a Raptor build can return a transaction that reverts on chain
 * (`Custom 6038`, `Custom 6006`) while Jupiter's `/order` refuses the same pair up front. One such leg
 * poisoned a whole batch — `send_many_txns` answered a single 417 for all of them and only one landed.
 * This guard runs before anything is signed.
 */
describe('dropRevertingPreparedSwaps', () => {
  it('drops the leg that would revert and keeps the rest', async () => {
    const connection = {
      simulateTransaction: vi.fn(async (tx: string) =>
        tx === 'bad'
          ? { value: { err: { InstructionError: [3, { Custom: 6038 }] } } }
          : { value: { err: null } },
      ),
    } as never

    const items = [
      { key: 'a', tx: 'good', meta: {} },
      { key: 'b', tx: 'bad', meta: {} },
      { key: 'c', tx: 'good', meta: {} },
    ]
    const { keep, dropped } = await dropRevertingPreparedSwaps(items as never, connection)

    expect(keep.map((i) => i.key)).toEqual(['a', 'c'])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.key).toBe('b')
    expect(dropped[0]!.reason).toContain('6038')
  })

  it('FAILS OPEN — a simulation that cannot run keeps the leg', async () => {
    // Dropping on an unreadable simulation would silently discard good trades, which is worse than the
    // fee it saves. Only a simulation that *returns* an error may drop anything.
    const connection = {
      simulateTransaction: vi.fn(async () => {
        throw new Error('429 Too Many Requests')
      }),
    } as never

    const { keep, dropped } = await dropRevertingPreparedSwaps(
      [{ key: 'a', tx: 'x', meta: {} }] as never,
      connection,
    )

    expect(keep).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it('keeps everything when nothing reverts', async () => {
    const connection = {
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
    } as never

    const items = [1, 2, 3].map((n) => ({ key: `m${n}`, tx: n, meta: {} }))
    const { keep, dropped } = await dropRevertingPreparedSwaps(items as never, connection)

    expect(keep.map((i) => i.key)).toEqual(['m1', 'm2', 'm3'])
    expect(dropped).toHaveLength(0)
  })
})
