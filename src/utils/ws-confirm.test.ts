import { describe, expect, it, vi } from 'vitest'
import { confirmSignaturesViaWs } from '@/utils/ws-confirm'

class FakeWebSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }

  /** Test helpers */
  open() {
    this.onopen?.()
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  /** Ack subscription for the nth sent request and return its subscription id. */
  ackSubscription(requestId: number, subscriptionId: number) {
    this.message({ jsonrpc: '2.0', id: requestId, result: subscriptionId })
  }

  notify(subscriptionId: number, err: unknown = null) {
    this.message({
      jsonrpc: '2.0',
      method: 'signatureNotification',
      params: { subscription: subscriptionId, result: { value: { err } } },
    })
  }
}

function setup(signatures: string[], options?: Parameters<typeof confirmSignaturesViaWs>[2]) {
  const socket = new FakeWebSocket()
  const promise = confirmSignaturesViaWs(signatures, 'wss://test', {
    timeoutMs: 200,
    snapshotDelayMs: 10,
    ...options,
    webSocketFactory: () => socket as unknown as WebSocket,
  })
  return { socket, promise }
}

describe('confirmSignaturesViaWs', () => {
  it('resolves signatures from WS notifications', async () => {
    const { socket, promise } = setup(['sig-a', 'sig-b'])

    socket.open()
    expect(socket.sent).toHaveLength(2)
    socket.ackSubscription(1, 101)
    socket.ackSubscription(2, 102)
    socket.notify(101)
    socket.notify(102)

    const results = await promise
    expect(results.get('sig-a')).toBeNull()
    expect(results.get('sig-b')).toBeNull()
    expect(socket.closed).toBe(true)
  })

  it('reports on-chain errors from notifications', async () => {
    const { socket, promise } = setup(['sig-a'])

    socket.open()
    socket.ackSubscription(1, 101)
    socket.notify(101, { InstructionError: [0, 'Custom'] })

    const results = await promise
    expect(results.get('sig-a')).toContain('failed on-chain')
  })

  it('resolves already-landed txs via checkNow snapshot', async () => {
    const checkNow = vi.fn(async (sigs: string[]) => {
      const map = new Map<string, string | null>()
      for (const sig of sigs) map.set(sig, null)
      return map
    })
    const { socket, promise } = setup(['sig-a'], { checkNow })

    socket.open()
    socket.ackSubscription(1, 101)
    // No notification — snapshot must resolve it

    const results = await promise
    expect(checkNow).toHaveBeenCalledWith(['sig-a'])
    expect(results.get('sig-a')).toBeNull()
  })

  it('leaves unresolved signatures absent after timeout (caller falls back)', async () => {
    const { socket, promise } = setup(['sig-a', 'sig-b'])

    socket.open()
    socket.ackSubscription(1, 101)
    socket.ackSubscription(2, 102)
    socket.notify(101)
    // sig-b never notifies

    const results = await promise
    expect(results.get('sig-a')).toBeNull()
    expect(results.has('sig-b')).toBe(false)
  })

  it('returns empty map when the socket errors immediately', async () => {
    const { socket, promise } = setup(['sig-a'])

    socket.onerror?.()

    const results = await promise
    expect(results.size).toBe(0)
  })
})
