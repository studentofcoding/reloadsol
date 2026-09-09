import { describe, expect, it } from 'vitest'
import {
  expandRhBalanceEvent,
  expandRhLedgerEvent,
  type RhLedgerEvent,
} from './rh-ledger'

const EVENT: RhLedgerEvent = {
  id: 'some-goldsky-id',
  address: '0x0000000000000000000000000000000000c0ffee',
  sender: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  amount: '123456789012345678901234567890',
  block_number: 12345,
  block_timestamp: 1700000000,
  transaction_hash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  log_index: 7,
}

describe('expandRhLedgerEvent', () => {
  it('expands a transfer into sender-out + recipient-in rows', () => {
    const rows = expandRhLedgerEvent(EVENT)
    expect(rows).toHaveLength(2)

    const [out, inn] = rows
    expect(out.direction).toBe('out')
    expect(out.wallet_address).toBe(EVENT.sender)
    expect(out.counterparty).toBe(EVENT.recipient)
    expect(out.id).toBe(
      `${EVENT.transaction_hash}:${EVENT.log_index}:out`,
    )

    expect(inn.direction).toBe('in')
    expect(inn.wallet_address).toBe(EVENT.recipient)
    expect(inn.counterparty).toBe(EVENT.sender)
    expect(inn.id).toBe(`${EVENT.transaction_hash}:${EVENT.log_index}:in`)

    for (const r of rows) {
      expect(r.token_address).toBe(EVENT.address)
      expect(r.amount_raw).toBe(EVENT.amount)
      expect(r.block_number).toBe(12345)
      expect(r.log_index).toBe(7)
      expect(r.block_timestamp.toISOString()).toBe(
        new Date(1700000000 * 1000).toISOString(),
      )
    }
  })

  it('drops self-transfers', () => {
    const rows = expandRhLedgerEvent({
      ...EVENT,
      sender: EVENT.recipient,
    })
    expect(rows).toHaveLength(0)
  })

  it('drops malformed addresses and zero amounts', () => {
    expect(expandRhLedgerEvent({ ...EVENT, sender: 'not-an-address' })).toHaveLength(0)
    expect(expandRhLedgerEvent({ ...EVENT, address: '' })).toHaveLength(0)
    expect(expandRhLedgerEvent({ ...EVENT, amount: '0' })).toHaveLength(0)
    expect(expandRhLedgerEvent({ ...EVENT, amount: '00000' })).toHaveLength(0)
  })

  it('accepts decimal-looking amounts but stores integer raw', () => {
    const [out] = expandRhLedgerEvent({ ...EVENT, amount: '150.75' })
    expect(out.amount_raw).toBe('150')
  })

  it('normalizes mixed-case addresses and unix-millis timestamps', () => {
    const [, inn] = expandRhLedgerEvent({
      ...EVENT,
      recipient: '0x2222222222222222222222222222222222222222'.toUpperCase(),
      block_timestamp: 1700000000123, // ms
    })
    expect(inn.wallet_address).toBe(EVENT.recipient)
    expect(inn.block_timestamp.toISOString()).toBe(
      new Date(1700000000123).toISOString(),
    )
  })

  it('requires a valid block number and log index', () => {
    expect(expandRhLedgerEvent({ ...EVENT, block_number: -1 })).toHaveLength(0)
    expect(expandRhLedgerEvent({ ...EVENT, log_index: undefined })).toHaveLength(0)
  })
})

describe('expandRhBalanceEvent', () => {
  const BAL = {
    id: 'x',
    owner_address: '0x795B5C0c89fC5D3b0De6c04141C3F1b6C340603D',
    contract_address: '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf',
    token_id: 'null',
    token_type: 'ERC_20',
    balance: '86648465000000000000',
    block_number: 42000000,
    block_timestamp: 1700000000,
  }

  it('normalizes an ERC-20 balance row', () => {
    const row = expandRhBalanceEvent(BAL)
    expect(row).not.toBeNull()
    expect(row!.owner_address).toBe(BAL.owner_address.toLowerCase())
    expect(row!.token_address).toBe(BAL.contract_address.toLowerCase())
    expect(row!.balance_raw).toBe(BAL.balance)
    expect(row!.block_number).toBe(42000000)
  })

  it('keeps zero balances (clears a sold-out token)', () => {
    const row = expandRhBalanceEvent({ ...BAL, balance: '0' })
    expect(row).not.toBeNull()
    expect(row!.balance_raw).toBe('0')
  })

  it('rejects NFTs, malformed addresses and empty balances', () => {
    expect(expandRhBalanceEvent({ ...BAL, token_type: 'ERC_721' })).toBeNull()
    expect(
      expandRhBalanceEvent({ ...BAL, token_id: '123' }),
    ).toBeNull()
    expect(expandRhBalanceEvent({ ...BAL, owner_address: 'nope' })).toBeNull()
    expect(expandRhBalanceEvent({ ...BAL, balance: '' })).toBeNull()
  })
})
