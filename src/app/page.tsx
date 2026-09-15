import React, { Suspense } from 'react'
import { Metadata } from 'next'
import HomePageClient from './HomePageClient'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Reload Solana from unused memecoins',
  description:
    'Convert dust and unused tokens back to SOL, or buy multiple tokens in bulk with ReloadSOL.',
  path: '/',
})

export default function Home() {
  return (
    <Suspense fallback={
    <div className="min-h-screen bg-black py-8">
      <div className="container mx-auto px-4">
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center animate-pulse">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
            </div>
            <p className="text-gray-400">Loading...</p>
          </div>
        </div>
    </div>
    }>
      <HomePageClient />
    </Suspense>
  )
}
