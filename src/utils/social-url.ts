/** Shared with TrendingTokens.tsx social icon links. */
export type SocialKind = 'twitter' | 'telegram' | 'website'

export function socialUrl(
  raw: string | undefined,
  kind: SocialKind,
): string | null {
  const v = raw?.trim()
  if (!v) return null
  if (v.startsWith('http://') || v.startsWith('https://')) return v
  if (kind === 'twitter') return `https://x.com/${v.replace(/^@/, '')}`
  if (kind === 'telegram') {
    return `https://t.me/${v.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '')}`
  }
  return `https://${v}`
}
