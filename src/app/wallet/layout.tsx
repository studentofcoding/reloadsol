import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Wallet Management - Bulk Token Trader',
  description: 'Manage your Crossmint embedded wallet, migrate assets, and more.',
}

export default function WalletLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-gray-900">
      <nav className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <a href="/" className="text-white font-semibold text-lg">
                ← Back to Trading
              </a>
            </div>
            <div className="flex items-center space-x-4">
              <a 
                href="/wallet/migrate" 
                className="text-gray-300 hover:text-white px-3 py-2 rounded-md text-sm font-medium"
              >
                Migrate Wallet
              </a>
            </div>
          </div>
        </div>
      </nav>
      {children}
    </div>
  )
}