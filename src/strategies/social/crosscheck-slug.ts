export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'unknown'
}

export function buildStrategyId(
  dex: string,
  clusterName: string,
  channelName: string,
): string {
  return `${slugify(dex)}_${slugify(clusterName)}_${slugify(channelName)}`
}
