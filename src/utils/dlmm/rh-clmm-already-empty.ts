/** Match close.ts: `Position #${tokenId} not found or already empty` */
export function isAlreadyEmptyCloseError(message: string): boolean {
  return /not found or already empty/i.test(message)
}

export function clmmPositionKey(
  protocol: string,
  tokenId: string | number | bigint,
): string {
  return `${protocol}:${tokenId}`
}

export function findOrphanOpenMarkIds(
  openMarks: ReadonlyArray<{ id: string; protocol: string; token_id: string }>,
  liveKeys: ReadonlySet<string>,
): { markId: string; tokenId: string }[] {
  const out: { markId: string; tokenId: string }[] = []
  for (const m of openMarks) {
    const key = clmmPositionKey(m.protocol, m.token_id)
    if (!liveKeys.has(key)) {
      out.push({ markId: m.id, tokenId: m.token_id })
    }
  }
  return out
}

export function alreadyEmptyNotice(tokenIds: string[]): string {
  if (tokenIds.length === 0) return ''
  if (tokenIds.length === 1) {
    return `Position #${tokenIds[0]} already empty — marked closed`
  }
  return `${tokenIds.length} positions already empty — marked closed (e.g. #${tokenIds[0]})`
}
