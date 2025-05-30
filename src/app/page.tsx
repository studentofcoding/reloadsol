import BulkTokenBuyer from '@/components/BulkTokenBuyer'

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900 py-8">
      <div className="container mx-auto px-4">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-blue-600 bg-clip-text text-transparent mb-4">
            Solana Bulk Token Buyer
          </h1>
          <p className="text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
            Buy multiple meme tokens on Solana in a single transaction flow. 
            Enter your SOL amount and up to 10 token mint addresses.
          </p>
          <div className="mt-6 flex items-center justify-center space-x-6 text-sm text-slate-400">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
              <span>Jupiter Integration</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
              <span>Multi-Wallet Support</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></div>
              <span>Bulk Transactions</span>
            </div>
          </div>
        </div>
        
        <div className="max-w-4xl mx-auto">
          <BulkTokenBuyer />
        </div>
      </div>
    </main>
  )
} 