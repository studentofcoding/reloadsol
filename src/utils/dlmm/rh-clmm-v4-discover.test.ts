import { describe, expect, it } from 'vitest'
import { posmTokenIdsFromTransferLogs } from './rh-clmm/v4'
import type { Hex } from 'viem'

const padId = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex

describe('posmTokenIdsFromTransferLogs', () => {
  it('reads ERC721 tokenId from topics[3]', () => {
    const ids = posmTokenIdsFromTransferLogs([
      { topics: ['0x01', '0x02', '0x03', padId(9)] },
      { topics: ['0x01', '0x02', '0x03', padId(12)] },
    ])
    expect(ids.map((x) => x.toString()).sort()).toEqual(['12', '9'])
  })

  it('dedupes and skips short topics', () => {
    const ids = posmTokenIdsFromTransferLogs([
      { topics: ['0x01'] },
      { topics: ['0x01', '0x02', '0x03', padId(7)] },
      { topics: ['0x01', '0x02', '0x03', padId(7)] },
    ])
    expect(ids).toEqual([7n])
  })
})

describe('discoverV4TokenIds Transfer-log path', () => {
  it('uses chunked POSM Transfer getLogs before reverse-scan', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/utils/dlmm/rh-clmm/v4.ts'), 'utf8')
    expect(src).toContain('collectPosmTokenIdsFromTransferLogs')
    expect(src).toContain("event: POSM_TRANSFER")
    expect(src).toContain('args: { to: owner }')
    expect(src).not.toMatch(/Alchemy getNFTsForOwner/)
    const discover = src.slice(src.indexOf('async function discoverV4TokenIds'))
    expect(discover.indexOf('collectPosmTokenIdsFromTransferLogs')).toBeGreaterThan(0)
    expect(discover.indexOf("functionName: 'nextTokenId'")).toBeGreaterThan(
      discover.indexOf('collectPosmTokenIdsFromTransferLogs'),
    )
  })
})
