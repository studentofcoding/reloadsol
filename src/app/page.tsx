import React, { Suspense } from 'react'
import { Metadata } from 'next'

import HomePageClient from './HomePageClient'

export const metadata: Metadata = {
  title: 'ReloadSOL - Reload your Solana from worthless memecoins',
  description: 'Easily reload your Solana by converting dust tokens and useless tokens back to SOL. Trade smarter with bulk buy/sell operations powered by Jupiter.',
  keywords: 'Solana, SOL, reclaim solana, buy bulk tokens, buy memecoin, beli koin meme, reclaim your solana, burn token, reload sol dust tokens, token converter, crypto tools, blockchain, DeFi',
  openGraph: {
    title: 'ReloadSOL - Reload your Solana from worthless memecoins',
    description: 'Easily reload your Solana by converting dust tokens and useless tokens back to SOL. Trade smarter with bulk buy/sell operations.',
    url: 'https://v2.reloadsol.xyz',
    siteName: 'ReloadSOL',
    locale: 'en-US',
    type: 'website',
    images: [
      {
        url: 'https://v2.reloadsol.xyz/og-reload.png',
        width: 1200,
        height: 630,
        alt: 'ReloadSOL - Reload your Solana from worthless memecoins',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ReloadSOL - Reload your Solana from worthless memecoins',
    description: 'Easily reload your Solana by converting dust tokens and useless tokens back to SOL. Trade smarter with bulk buy/sell operations.',
    images: ['https://v2.reloadsol.xyz/og-reload.png'],
  },
}

export default function Home() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center animate-pulse">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <p className="text-gray-400">Loading...</p>
          </div>
        </div>
      </main>
    }>
      <HomePageClient />
    </Suspense>
  )
}