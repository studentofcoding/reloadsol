import type { Metadata } from 'next'

export const SITE_URL = 'https://reloadsol.app'

/** Wallet / token / internal surfaces — do not send crawlers. */
export const noIndexRobots: Metadata['robots'] = {
  index: false,
  follow: false,
  nocache: true,
}

export function canonical(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return new URL(normalized, SITE_URL).toString()
}

/** Public marketing / buy / sell / swap / blog metadata. */
export function publicPageMetadata({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}): Metadata {
  const url = canonical(path)
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url,
      siteName: 'ReloadSOL',
      locale: 'en-US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}
