'use client'

import React from 'react'
import { useSearchParams } from 'next/navigation'

function parseAddresses(param: string | null): string[] {
  if (!param) return []
  // Support comma or pipe separated lists and trim whitespace
  return param
    .split(/[|,]/)
    .map(s => s.trim())
    .filter(Boolean)
}

export default function MultiChartsPage() {
  const searchParams = useSearchParams()
  const addresses = parseAddresses(searchParams.get('addresses'))
  const interval = searchParams.get('interval') || '5'

  const charts = addresses.slice(0, 50) // safety cap

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Charts</h1>
        <p className="text-gray-400 mb-4">Showing {charts.length} chart{charts.length !== 1 ? 's' : ''} • interval {interval}</p>

        {charts.length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-4">
            <p className="text-gray-300 text-sm">Pass addresses in the query, e.g. <code className="text-xs">/charts?addresses=addr1,addr2</code></p>
          </div>
        ) : (
          <div
            className="grid"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, 500px)',
              gap: '12px'
            }}
          >
            {charts.map(addr => (
              <div key={addr} className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700" style={{ width: 500, height: 200 }}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                  <div className="text-sm font-medium">{addr}</div>
                  <a
                    href={`/chart/${addr}`}
                    className="text-xs text-blue-400 hover:text-blue-300 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open full
                  </a>
                </div>
                <iframe
                  src={`https://www.gmgn.cc/kline/sol/${addr}?interval=${interval}`}
                  title={`Chart ${addr}`}
                  frameBorder={0}
                  className="w-full"
                  style={{ height: 160 }}
                  allowFullScreen
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}