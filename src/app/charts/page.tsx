'use client'

import React, { useMemo, useState } from 'react'
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
  const [selected, setSelected] = useState<Set<string>>(new Set(charts))
  const [reason, setReason] = useState<string>('continue')
  const [status, setStatus] = useState<string>('')

  const selectedCount = useMemo(() => selected.size, [selected])

  async function applyStopReason(targets: string[]) {
    setStatus('')
    try {
      const resp = await fetch(`/api/mcap-tracking?action=stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: targets, reason })
      })
      const json = await resp.json()
      if (!resp.ok || json.success === false) {
        setStatus(`Failed: ${json.error || resp.status}`)
      } else {
        setStatus(`Updated ${json.updated} tokens (${reason === 'continue' ? 'continue' : reason})`)
      }
    } catch (e: any) {
      setStatus(`Error: ${e?.message || 'unknown'}`)
    }
  }

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
          <>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <button
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => setSelected(new Set(charts))}
                >
                  Select all
                </button>
                <button
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
                <span className="text-xs text-gray-300">Selected: {selectedCount}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-300">Action</label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1"
                >
                  <option value="continue">Continue</option>
                  <option value="rug">Stop (rug)</option>
                </select>
                <button
                  className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                  disabled={selectedCount === 0}
                  onClick={() => applyStopReason(Array.from(selected))}
                >
                  Apply to selected
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                  onClick={() => applyStopReason(charts)}
                >
                  Apply to all
                </button>
              </div>
            </div>
            {status && <div className="mb-3 text-xs text-gray-300">{status}</div>}

            <div
              className="grid"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, 400px)',
                gap: '12px'
              }}
            >
              {charts.map(addr => (
                <div key={addr} className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700" style={{ width: 400, height: 200 }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                    <div className="text-sm font-medium">{addr}</div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-xs text-gray-300">
                        <input
                          type="checkbox"
                          checked={selected.has(addr)}
                          onChange={(e) => {
                            const next = new Set(selected)
                            if (e.target.checked) next.add(addr)
                            else next.delete(addr)
                            setSelected(next)
                          }}
                        />
                        Select
                      </label>
                      <a
                        href={`/chart/${addr}`}
                        className="text-xs text-blue-400 hover:text-blue-300 underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open full
                      </a>
                    </div>
                  </div>
                  <iframe
                    src={`https://www.gmgn.cc/kline/sol/${addr}?interval=${interval}`}
                    title={`Chart ${addr}`}
                    frameBorder={0}
                    className="w-full"
                    style={{ height: 200 }}
                    allowFullScreen
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}