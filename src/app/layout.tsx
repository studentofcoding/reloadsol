import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import TradingDataProvider from "@/components/TradingDataProvider";
import Header from "@/components/Header";
import { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Reload your Solana & trade smarter with us!",
  description:
    "Easily reload your Solana with converting dust tokens and useless tokens back to SOL. Trade smarter with us!",
  icons: {
    icon: "/logo.png",
  },
  openGraph: {
    title:
      "Reclaim your Solana from worthless memecoins (via Reload or Swap & Reload)",
    description:
      "Easily reload your Solana with converting dust tokens and useless tokens back to SOL.",
    url: "https://reloadsol.app",
    siteName: "ReloadSOL",
    locale: "en-US",
    type: "website",
    images: [
      {
        url: "https://reloadsol.app/og-reload.png",
        width: 1200,
        height: 630,
        alt: "Reclaim your Solana from worthless memecoins (via Reload or Swap & Reload)",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Reload your Solana & trade smarter with us!",
    description:
      "Easily reload your Solana tokens with converting dust tokens and useless tokens back to SOL.",
    images: ["https://reloadsol.app/og-reload.png"],
  },
  keywords:
    "Solana, SOL, reclaim solana, buy bulk tokens, buy memecoin, beli koin meme, reclaim your solana, burn token, reload sol dust tokens, token converter, crypto tools, blockchain, DeFi",
  authors: [{ name: "ReloadSOL Team" }],
  metadataBase: new URL("https://reloadsol.app"),
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only load Vercel Analytics when actually deployed on Vercel
  const isVercelDeployment =
    process.env.VERCEL === "1" || process.env.VERCEL_URL;

  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <WalletProvider>
          <TradingDataProvider>
            <div className="min-h-screen bg-black">
              <Header />
              <main className="flex-1">{children}</main>
            </div>
          </TradingDataProvider>
        </WalletProvider>
        {isVercelDeployment && <Analytics />}
        <Script
          src="https://scripts.simpleanalyticscdn.com/latest.js"
          strategy="lazyOnload"
        />
        <Script
          src="https://terminal.jup.ag/main-v4.js"
          strategy="lazyOnload"
          data-enable-lazy-load
        />
      </body>
    </html>
  );
}
