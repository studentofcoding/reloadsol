import './globals.css'
import { WalletProvider } from '@/components/WalletProvider'
// import { PasswordGate } from '@/components/PasswordGate'
import { Metadata } from 'next';

// This is needed for static export with App Router
export function generateStaticParams() {
  return [];
}

export const metadata: Metadata = {
  title: 'Reload your Solana & trade smarter with us!',
  description: 'Easily reload your Solana with converting dust tokens and useless tokens back to SOL. Trade smarter with us!',
  icons: {
    icon: '/logo.png',
  },
  openGraph: {
    title: 'Reclaim your Solana from worthless memecoins (via Reload or Swap & Reload)',
    description: 'Easily reload your Solana with converting dust tokens and useless tokens back to SOL.',
    url: 'https://v2.reloadsol.xyz',
    siteName: 'ReloadSOL',
    locale: 'en-US',
    type: 'website',
    images: [
      {
        url: 'https://v2.reloadsol.xyz/og-reload.png',
        width: 1200,
        height: 630,
        alt: 'Reclaim your Solana from worthless memecoins (via Reload or Swap & Reload)',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Reload your Solana & trade smarter with us!',
    description: 'Easily reload your Solana tokens with converting dust tokens and useless tokens back to SOL.',
    images: ['https://v2.reloadsol.xyz/og-reload.png'],
  },
  keywords: 'Solana, SOL, reclaim solana, buy bulk tokens, buy memecoin, beli koin meme, reclaim your solana, burn token, reload sol dust tokens, token converter, crypto tools, blockchain, DeFi',
  authors: [{ name: 'ReloadSOL Team' }],
  metadataBase: new URL('https://v2.reloadsol.xyz'),
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          {children}
        </WalletProvider>
      </body>
      <script async src="https://scripts.simpleanalyticscdn.com/latest.js"></script>
    </html>
  )
} 