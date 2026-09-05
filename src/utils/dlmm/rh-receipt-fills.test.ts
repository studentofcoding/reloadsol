import { describe, expect, it } from 'vitest'
import {
  ERC20_TRANSFER_TOPIC,
  erc20ReceivedFromLogs,
} from './rh-receipt-fills'

const TOKEN = '0x00000000000000000000000000000000000000aa'
const TO = '0x00000000000000000000000000000000000000bb'
const FROM = '0x00000000000000000000000000000000000000cc'

function padAddr(addr: string): `0x${string}` {
  return `0x${addr.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`
}

describe('erc20ReceivedFromLogs', () => {
  it('sums Transfer logs to the recipient for that token', () => {
    const logs = [
      {
        address: TOKEN,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padAddr(FROM),
          padAddr(TO),
        ],
        data: '0x' + (100n).toString(16).padStart(64, '0'),
      },
      {
        address: TOKEN,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padAddr(FROM),
          padAddr(TO),
        ],
        data: '0x' + (50n).toString(16).padStart(64, '0'),
      },
      {
        address: TOKEN,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padAddr(FROM),
          padAddr(FROM),
        ],
        data: '0x' + (999n).toString(16).padStart(64, '0'),
      },
    ]
    expect(erc20ReceivedFromLogs(logs, TOKEN, TO)).toBe(150n)
  })

  it('ignores other tokens', () => {
    const logs = [
      {
        address: '0x00000000000000000000000000000000000000dd',
        topics: [ERC20_TRANSFER_TOPIC, padAddr(FROM), padAddr(TO)],
        data: '0x' + (9n).toString(16).padStart(64, '0'),
      },
    ]
    expect(erc20ReceivedFromLogs(logs, TOKEN, TO)).toBe(0n)
  })
})
