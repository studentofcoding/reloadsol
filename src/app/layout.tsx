import "./globals.css";
import { Suspense } from "react";
import { WalletProvider } from "@/components/WalletProvider";
import AppQueryClientProvider from "@/components/AppQueryClientProvider";
import Header from "@/components/Header";
import McapSimOpenToastHost from "@/components/signals/McapSimOpenToastHost";
import { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import Script from "next/script";
import { SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Reload your Solana & trade smarter",
    template: "%s · ReloadSOL",
  },
  description:
    "Reload dust and unused tokens back to SOL, or buy multiple tokens in bulk. Trade smarter with ReloadSOL.",
  icons: {
    icon: "/logo.png",
  },
  openGraph: {
    title: "ReloadSOL — reload Solana from unused memecoins",
    description:
      "Convert dust tokens back to SOL, or split a buy across multiple tokens.",
    url: SITE_URL,
    siteName: "ReloadSOL",
    locale: "en-US",
    type: "website",
    images: [
      {
        url: "/og-reload.png",
        width: 1200,
        height: 630,
        alt: "ReloadSOL — reload Solana from unused memecoins",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Reload your Solana & trade smarter",
    description:
      "Convert dust tokens back to SOL, or split a buy across multiple tokens.",
    images: ["/og-reload.png"],
  },
  keywords:
    "Solana, SOL, reclaim solana, buy bulk tokens, buy memecoin, reload sol dust tokens, token converter, DeFi",
  authors: [{ name: "ReloadSOL Team" }],
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
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <AppQueryClientProvider>
          <WalletProvider>
            <div className="min-h-screen bg-black">
              <Header />
              <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
                {children}
              </main>
            </div>
            <Suspense fallback={null}>
              <McapSimOpenToastHost />
            </Suspense>
          </WalletProvider>
        </AppQueryClientProvider>
        {isVercelDeployment && <Analytics />}
        <Script
          src="https://scripts.simpleanalyticscdn.com/latest.js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
