export type BlogFrontMatter = {
  title: string
  date: string
  author: string
  excerpt?: string
}

export function parseFrontMatter(raw: string): {
  data: Partial<BlogFrontMatter>
  content: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }

  const data: Partial<BlogFrontMatter> = {}
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const field = trimmed.match(/^([a-zA-Z_]+):\s*(.+)$/)
    if (!field) continue
    const key = field[1] as keyof BlogFrontMatter
    let value = field[2].trim()
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    if (key === 'title' || key === 'date' || key === 'author' || key === 'excerpt') {
      data[key] = value
    }
  }

  return { data, content: match[2] }
}
