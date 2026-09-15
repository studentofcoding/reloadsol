import type { Metadata } from 'next'

export const SITE_URL = 'https://reloadsol.app'

/** Shared social card — child openGraph/twitter replace the root, so keep images here. */
export const OG_IMAGE = {
  url: '/og-reload.png',
  width: 1200,
  height: 630,
  alt: 'ReloadSOL — reload Solana from unused memecoins',
} as const

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
  type = 'website',
}: {
  title: string
  description: string
  path: string
  type?: 'website' | 'article'
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
      type,
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [OG_IMAGE.url],
    },
  }
}
