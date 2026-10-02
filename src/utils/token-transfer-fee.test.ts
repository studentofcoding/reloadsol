import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT,
  TOKEN_2022_PROGRAM_ID,
  applyTransferFeeFloor,
  getTransferFeeBps,
  getTransferFeeMarginBps,
  resetTransferFeeCacheForTests,
  transferFeeBpsFromMintAccount,
  withTransferFeeFloor,
} from '@/utils/token-transfer-fee'

const DEW = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'

function mintAccount(opts: {
  owner?: string
  state?: unknown
  extension?: string
}) {
  return {
    owner: opts.owner ?? TOKEN_2022_PROGRAM_ID,
    data: {
      parsed: {
        info: {
          extensions: [
            { extension: opts.extension ?? 'transferFeeConfig', state: opts.state },
          ],
        },
      },
    },
  }
}

const CONFIGS = {
  olderTransferFee: { epoch: 1, transferFeeBasisPoints: 100, maximumFee: '1000000000000000' },
  newerTransferFee: { epoch: 1039, transferFeeBasisPoints: 250, maximumFee: '1000000000000000' },
}

describe('applyTransferFeeFloor', () => {
  it('raises slippage to fee + margin when the fee would consume the budget', () => {
    expect(applyTransferFeeFloor(20, 100, 30)).toBe(130)
    expect(applyTransferFeeFloor(100, 100, 30)).toBe(130)
  })

  it('never lowers a slippage that is already above the floor', () => {
    expect(applyTransferFeeFloor(500, 100, 30)).toBe(500)
  })

  it('is a no-op without a fee', () => {
    expect(applyTransferFeeFloor(200, 0, 30)).toBe(200)
  })

  it('leaves the Auto sentinel untouched so resolveAutoSlippageBps still owns it', () => {
    expect(applyTransferFeeFloor(-1, 100, 30)).toBe(-1)
  })

  it('rounds a fractional fee up', () => {
    expect(applyTransferFeeFloor(20, 100.4, 30)).toBe(131)
  })
})

describe('getTransferFeeMarginBps', () => {
  it('defaults, reads env, and ignores junk', () => {
    expect(getTransferFeeMarginBps({})).toBe(SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT)
    expect(getTransferFeeMarginBps({ SWAP_TRANSFER_FEE_MARGIN_BPS: '75' })).toBe(75)
    expect(getTransferFeeMarginBps({ SWAP_TRANSFER_FEE_MARGIN_BPS: '-5' })).toBe(
      SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT,
    )
    expect(getTransferFeeMarginBps({ SWAP_TRANSFER_FEE_MARGIN_BPS: 'x' })).toBe(
      SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT,
    )
  })
})

describe('transferFeeBpsFromMintAccount', () => {
  it('reads the flat shape the RPC emits', () => {
    expect(transferFeeBpsFromMintAccount(mintAccount({ state: CONFIGS }), 1039)).toBe(250)
  })

  it('reads the nested shape', () => {
    const account = mintAccount({ state: { transferFeeConfig: CONFIGS } })
    expect(transferFeeBpsFromMintAccount(account, 1039)).toBe(250)
  })

  it('uses the older config until the newer epoch has passed', () => {
    const account = mintAccount({ state: CONFIGS })
    expect(transferFeeBpsFromMintAccount(account, 1038)).toBe(100)
    expect(transferFeeBpsFromMintAccount(account, 1039)).toBe(250)
  })

  it('returns 0 for a mint with no transfer-fee extension, and for junk', () => {
    expect(
      transferFeeBpsFromMintAccount(mintAccount({ extension: 'metadataPointer' }), 1),
    ).toBe(0)
    expect(transferFeeBpsFromMintAccount({ data: { parsed: { info: {} } } }, 1)).toBe(0)
    expect(transferFeeBpsFromMintAccount(null, 1)).toBe(0)
    expect(transferFeeBpsFromMintAccount({}, 1)).toBe(0)
  })
})

describe('getTransferFeeBps', () => {
  beforeEach(() => {
    resetTransferFeeCacheForTests()
    vi.unstubAllGlobals()
  })

  function stubRpc(account: unknown) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      const result =
        body.method === 'getEpochInfo'
          ? { result: { epoch: 1039 } }
          : { result: { value: account } }
      return { ok: true, json: async () => result } as unknown as Response
    })
  }

  it('returns the fee for a Token-2022 mint', async () => {
    vi.stubGlobal('fetch', stubRpc(mintAccount({ state: CONFIGS })))
    expect(await getTransferFeeBps(DEW)).toBe(250)
  })

  it('returns 0 for a classic SPL mint without asking for the epoch', async () => {
    const fetchMock = stubRpc(mintAccount({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getTransferFeeBps(DEW)).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches, so a second swap on the same mint costs nothing', async () => {
    const fetchMock = stubRpc(mintAccount({ state: CONFIGS }))
    vi.stubGlobal('fetch', fetchMock)
    await getTransferFeeBps(DEW)
    const before = fetchMock.mock.calls.length
    await getTransferFeeBps(DEW)
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('fails open to 0 when the RPC is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await getTransferFeeBps(DEW)).toBe(0)
  })
})

describe('withTransferFeeFloor', () => {
  beforeEach(() => {
    resetTransferFeeCacheForTests()
    vi.unstubAllGlobals()
  })

  it('raises a 20 bps auto floor to fee + margin for a fee-bearing mint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      return {
        ok: true,
        json: async () =>
          body.method === 'getEpochInfo'
            ? { result: { epoch: 1039 } }
            : { result: { value: mintAccount({ state: CONFIGS }) } },
      } as unknown as Response
    }))
    const result = await withTransferFeeFloor(DEW, 20, {})
    expect(result.feeBps).toBe(250)
    expect(result.slippageBps).toBe(280)
  })
})
