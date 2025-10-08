"use client"
import React, { useEffect, useMemo, useState } from "react"
import Draggable from 'react-draggable'

type SignalItem = {
  token_address: string
  token_symbol?: string
  current_mcap?: number
  first_mcap?: number
  mcap_growth_percent?: number
  score?: number
  decision?: "enter" | "hold" | "exit" | "skip"
  rationale?: string
  first_seen_at?: string
  last_updated_at?: string
  when_reach_80mc?: string | null
  when_reach_120mc?: string | null
  when_reach_200mc?: string | null
  is_tracking_stuck?: boolean
}

type SignalsResponse = {
  success: boolean
  params?: Record<string, any>
  stats?: Record<string, any>
  signals?: SignalItem[]
}

type FloatingChart = {
  id: string
  tokenAddress: string
  tokenSymbol?: string
  position: { x: number; y: number }
  zIndex: number
  isLoading: boolean
  isInGrid: boolean
  isDraggable: boolean
  gridOrder: number
}

const numberFmt = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n)) return "—"
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)
}

const percentFmt = (p?: number) => {
  if (p === undefined || p === null || Number.isNaN(p)) return "—"
  return `${p.toFixed(2)}%`
}

const dateFmt = (iso?: string | null) => {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return "—"
    return d.toLocaleString()
  } catch {
    return "—"
  }
}

export default function TradingSignals() {
  const [isClient, setIsClient] = useState(false)
  const [limit, setLimit] = useState(50)
  const [recencyMinutes, setRecencyMinutes] = useState(240)
  const [minGrowth, setMinGrowth] = useState(0)
  const [includeStuck, setIncludeStuck] = useState(false)
  const [maxAgeMinutes, setMaxAgeMinutes] = useState(48 * 60)
  const [strategy, setStrategy] = useState<'default' | 'sell_over_100'>('sell_over_100')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>("")
  const [signals, setSignals] = useState<SignalItem[]>([])
  const [stats, setStats] = useState<Record<string, any>>({})

  // Multiple floating charts state
  const [floatingCharts, setFloatingCharts] = useState<FloatingChart[]>([])
  const [nextZIndex, setNextZIndex] = useState(200)

  // Buy configuration state
  const [buyConfig, setBuyConfig] = useState({
    solAmount: 0.1,
    fees: 0.005
  })
  const [buyingTokens, setBuyingTokens] = useState<Set<string>>(new Set())

  useEffect(() => {
    setIsClient(true)
  }, [])

  const query = useMemo(() => {
    if (!isClient) return ""
    const params = new URLSearchParams()
    params.set("limit", String(limit))
    params.set("recencyMinutes", String(recencyMinutes))
    params.set("minGrowth", String(minGrowth))
    params.set("includeStuck", String(includeStuck))
    params.set("maxAgeMinutes", String(maxAgeMinutes))
    params.set("strategy", strategy)
    return params.toString()
  }, [isClient, limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes, strategy])

  const fetchSignals = async () => {
    try {
      setLoading(true)
      setError("")
      const res = await fetch(`/api/trading/signals?${query}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to fetch signals (${res.status})`)
      const data: SignalsResponse = await res.json()
      if (!data.success) throw new Error("Signals API returned unsuccessful response")
      setSignals(data.signals || [])
      setStats(data.stats || {})
    } catch (e: any) {
      setError(e?.message || "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const decisionBadge = (d?: SignalItem["decision"]) => {
    const base = "px-2 py-0.5 rounded text-xs font-medium"
    switch (d) {
      case "enter":
        return <span className={`${base} bg-green-100 text-green-700`}>enter</span>
      case "hold":
        return <span className={`${base} bg-yellow-100 text-yellow-700`}>hold</span>
      case "exit":
        return <span className={`${base} bg-red-100 text-red-700`}>exit</span>
      case "skip":
        return <span className={`${base} bg-gray-100 text-gray-700`}>skip</span>
      default:
        return <span className={`${base} bg-gray-100 text-gray-700`}>n/a</span>
    }
  }

  // Chart popup handlers
  const handleOpenChart = (tokenAddress: string, tokenSymbol?: string) => {
    // Check if chart is already open
    const existingChart = floatingCharts.find(chart => chart.tokenAddress === tokenAddress)
    if (existingChart) {
      // Bring to front by updating z-index
      setFloatingCharts(prev => prev.map(chart => 
        chart.id === existingChart.id 
          ? { ...chart, zIndex: nextZIndex }
          : chart
      ))
      setNextZIndex(prev => prev + 1)
      return
    }

    // Calculate position for new chart in grid area
    const gridCharts = floatingCharts.filter(chart => chart.isInGrid)
    const gridPosition = {
      x: 10, // Fixed left position in grid area
      y: 30 + (gridCharts.length * 280) // Stack vertically with reduced spacing
    }

    // Create new floating chart
    const newChart: FloatingChart = {
      id: `chart-${tokenAddress}-${Date.now()}`,
      tokenAddress,
      tokenSymbol,
      position: gridPosition,
      zIndex: nextZIndex,
      isLoading: true,
      isInGrid: true,
      isDraggable: false,
      gridOrder: gridCharts.length
    }

    setFloatingCharts(prev => [...prev, newChart])
    setNextZIndex(prev => prev + 1)
  }

  const handleCloseChart = (chartId: string) => {
    setFloatingCharts(prev => prev.filter(chart => chart.id !== chartId))
  }

  const handleChartLoad = (chartId: string) => {
    setFloatingCharts(prev => prev.map(chart => 
      chart.id === chartId 
        ? { ...chart, isLoading: false }
        : chart
    ))
  }

  const handleChartError = (chartId: string) => {
    console.error('Chart failed to load for chart:', chartId)
    setFloatingCharts(prev => prev.map(chart => 
      chart.id === chartId 
        ? { ...chart, isLoading: false }
        : chart
    ))
  }

  const handleReorderCharts = (draggedChartId: string, targetChartId: string) => {
    setFloatingCharts(prev => {
      const draggedChart = prev.find(chart => chart.id === draggedChartId)
      const targetChart = prev.find(chart => chart.id === targetChartId)
      
      if (!draggedChart || !targetChart) return prev
      
      const draggedOrder = draggedChart.gridOrder
      const targetOrder = targetChart.gridOrder
      
      return prev.map(chart => {
        if (chart.id === draggedChartId) {
          return { ...chart, gridOrder: targetOrder }
        } else if (chart.id === targetChartId) {
          return { ...chart, gridOrder: draggedOrder }
        }
        return chart
      })
    })
  }

  const handleDragStart = (chartId: string) => {
    // Enable dragging when user starts to drag
    setFloatingCharts(prev => prev.map(chart => 
      chart.id === chartId 
        ? { ...chart, isDraggable: true }
        : chart
    ))
  }

  const handleDragStop = (chartId: string, data: any) => {
    // Define grid area boundaries (left 1/5 of the container)
    const containerWidth = window.innerWidth
    const GRID_WIDTH = containerWidth * 0.2 // 20% of container width
    const GRID_HEIGHT = window.innerHeight - 100 // Full height minus some padding
    
    const isInGridArea = data.x >= 0 && data.x <= GRID_WIDTH && data.y >= 0 && data.y <= GRID_HEIGHT
    
    setFloatingCharts(prev => prev.map(chart => {
      if (chart.id === chartId) {
        let newPosition = { x: data.x, y: data.y }
        let newIsInGrid = isInGridArea
        
        // If moved into grid area, snap to grid position
        if (isInGridArea && !chart.isInGrid) {
          const gridCharts = prev.filter(c => c.isInGrid && c.id !== chartId)
          newPosition = {
            x: 10,
            y: 30 + (gridCharts.length * 280) // Reduced spacing for smaller area
          }
          newIsInGrid = true
        }
        // If moved out of grid area, ensure it's marked as not in grid
        else if (!isInGridArea && chart.isInGrid) {
          newIsInGrid = false
        }
        
        return { 
          ...chart, 
          position: newPosition,
          isInGrid: newIsInGrid,
          isDraggable: true
        }
      }
      return chart
    }))
  }

  // Buy functionality
  const handleBuyToken = async (tokenAddress: string, tokenSymbol?: string) => {
    if (buyingTokens.has(tokenAddress)) return

    setBuyingTokens(prev => new Set(prev).add(tokenAddress))
    
    try {
      // TODO: Implement actual buy logic here
      console.log(`Buying ${tokenSymbol || tokenAddress} with ${buyConfig.solAmount} SOL`)
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // Show success message or handle result
      alert(`Successfully bought ${tokenSymbol || tokenAddress}!`)
      
    } catch (error) {
      console.error('Buy error:', error)
      alert(`Failed to buy ${tokenSymbol || tokenAddress}`)
    } finally {
      setBuyingTokens(prev => {
        const newSet = new Set(prev)
        newSet.delete(tokenAddress)
        return newSet
      })
    }
  }

  return (
    <div className="space-y-4">
      {!isClient ? (
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded mb-4"></div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      ) : (
        <>
          <div className="flex items-end flex-wrap gap-3 z-[-1]">
            <div>
              <label className="block text-sm font-medium">Strategy</label>
              <select
                value={strategy}
                onChange={e => setStrategy(e.target.value as 'default' | 'sell_over_100')}
                className="mt-1 w-40 rounded border px-2 py-1 bg-black text-white"
              >
                <option value="default">Default</option>
                <option value="sell_over_100">Sell Over 100%</option>
              </select>
            </div>

            {/* Buy Configuration */}
            <div>
              <label className="block text-sm font-medium">Buy Amount (SOL)</label>
              <input
                type="number"
                min={0.01}
                max={10}
                step={0.01}
                value={buyConfig.solAmount}
                onChange={e => setBuyConfig(prev => ({ ...prev, solAmount: Number(e.target.value) }))}
                className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Fees (SOL)</label>
              <input
                type="number"
                min={0.001}
                max={1}
                step={0.001}
                value={buyConfig.fees}
                onChange={e => setBuyConfig(prev => ({ ...prev, fees: Number(e.target.value) }))}
                className="mt-1 w-28 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
        <div>
          <label className="block text-sm font-medium">Limit</label>
          <input
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="mt-1 w-24 rounded border px-2 py-1 bg-black text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Recency (min)</label>
          <input
            type="number"
            min={0}
            value={recencyMinutes}
            onChange={e => setRecencyMinutes(Number(e.target.value))}
            className="mt-1 w-28 rounded border px-2 py-1 bg-black text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Min Growth (%)</label>
          <input
            type="number"
            min={0}
            value={minGrowth}
            onChange={e => setMinGrowth(Number(e.target.value))}
            className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="includeStuck"
            type="checkbox"
            checked={includeStuck}
            onChange={e => setIncludeStuck(e.target.checked)}
          />
          <label htmlFor="includeStuck" className="text-sm font-medium">Include Stuck</label>
        </div>
        <div>
          <label className="block text-sm font-medium">Max Age (min)</label>
          <input
            type="number"
            min={0}
            value={maxAgeMinutes}
            onChange={e => setMaxAgeMinutes(Number(e.target.value))}
            className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
          />
        </div>
        <button
          onClick={fetchSignals}
          className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700"
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-4">
        {/* Chart Grid Area - 1/5 of the width */}
        <div 
          className="flex-shrink-0 bg-black rounded-lg relative overflow-y-auto"
          style={{ width: '20%', minHeight: '600px' }}
        >
          <div className="absolute top-2 left-2 text-xs text-gray-500 font-medium z-10">
            Chart Area
          </div>
          
          {/* Non-draggable charts inside grid */}
          <div className="pt-8 space-y-4 p-2">
            {floatingCharts
              .filter(chart => chart.isInGrid && !chart.isDraggable)
              .sort((a, b) => a.gridOrder - b.gridOrder)
              .map((chart) => (
                <div 
                  key={chart.id}
                  className="bg-white border-2 border-gray-300 rounded-lg shadow-2xl"
                  style={{ 
                    width: '100%', 
                    height: '260px'
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', chart.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const draggedChartId = e.dataTransfer.getData('text/plain')
                    if (draggedChartId !== chart.id) {
                      handleReorderCharts(draggedChartId, chart.id)
                    }
                  }}
                >
                  {/* Header with close button and buy controls */}
                  <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg drag-handle cursor-move">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-gray-800">{chart.tokenSymbol || "UNKNOWN"}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-600">{buyConfig.solAmount} SOL</span>
                        <button
                          onClick={() => handleBuyToken(chart.tokenAddress, chart.tokenSymbol)}
                          disabled={buyingTokens.has(chart.tokenAddress)}
                          className={`px-3 py-1 rounded text-sm font-medium ${
                            buyingTokens.has(chart.tokenAddress)
                              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                              : 'bg-green-500 hover:bg-green-600 text-white cursor-pointer'
                          }`}
                        >
                          {buyingTokens.has(chart.tokenAddress) ? 'Buying...' : 'Buy'}
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCloseChart(chart.id)}
                      className="text-gray-500 hover:text-gray-700 text-xl font-bold"
                    >
                      ×
                    </button>
                  </div>

                  {/* Chart iframe */}
                  <iframe
                    src={`https://www.gmgn.cc/kline/sol/${chart.tokenAddress}?interval=5`}
                    className="w-full h-full rounded-b-lg"
                    style={{ 
                      height: 'calc(100% - 60px)',
                      display: chart.isLoading ? 'none' : 'block' 
                    }}
                    title={`GMGN Chart - ${chart.tokenAddress}`}
                    onLoad={() => handleChartLoad(chart.id)}
                    onError={() => handleChartError(chart.id)}
                    allowFullScreen
                    frameBorder="0"
                  />
                </div>
              ))
            }
            
            {floatingCharts.filter(chart => chart.isInGrid).length === 0 && (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                Charts will appear here when opened
              </div>
            )}
          </div>
        </div>

        {/* Table Area - 4/5 of the width */}
        <div className="flex-1 overflow-x-auto z-[100] relative">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="text-left text-sm">
                <th className="border-b p-2">Token</th>
                <th className="border-b p-2">Address</th>
              <th className="border-b p-2">Growth %</th>
              <th className="border-b p-2">Score</th>
              <th className="border-b p-2">Decision</th>
              <th className="border-b p-2">Rationale</th>
              <th className="border-b p-2">First Seen</th>
              <th className="border-b p-2">Last Updated</th>
              <th className="border-b p-2">80%</th>
              <th className="border-b p-2">120%</th>
              <th className="border-b p-2">200%</th>
              <th className="border-b p-2">Stuck</th>
              <th className="border-b p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {signals.length === 0 && !loading ? (
              <tr>
                <td className="p-4 text-center text-sm" colSpan={13}>No signals</td>
              </tr>
            ) : (
              signals.map((s) => (
                <tr key={`${s.token_address}-${s.last_updated_at || s.first_seen_at || "0"}`} className="text-sm">
                  <td className="border-b p-2 relative">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.token_symbol || "UNKNOWN"}</span>
                      <button
                        onClick={() => handleOpenChart(s.token_address, s.token_symbol)}
                        className="text-blue-600 hover:text-blue-800 p-1"
                        title="View Chart"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                      </button>
                    </div>

                  </td>
                  <td className="border-b p-2">
                    <code className="text-xs">{s.token_address}</code>
                  </td>
                  <td className="border-b p-2">{percentFmt(s.mcap_growth_percent)}</td>
                  <td className="border-b p-2">{numberFmt(s.score)}</td>
                  <td className="border-b p-2">{decisionBadge(s.decision)}</td>
                  <td className="border-b p-2 max-w-xs">
                    <div className="truncate" title={s.rationale || ""}>{s.rationale || ""}</div>
                  </td>
                  <td className="border-b p-2">{dateFmt(s.first_seen_at)}</td>
                  <td className="border-b p-2">{dateFmt(s.last_updated_at)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_80mc)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_120mc)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_200mc)}</td>
                  <td className="border-b p-2">{s.is_tracking_stuck ? "Yes" : "No"}</td>
                  <td className="border-b p-2">
                    <button
                      onClick={() => handleBuyToken(s.token_address, s.token_symbol)}
                      disabled={buyingTokens.has(s.token_address)}
                      className={`px-3 py-1 rounded text-xs font-medium ${
                        buyingTokens.has(s.token_address)
                          ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                          : 'bg-green-600 text-white hover:bg-green-700'
                      }`}
                      title={`Buy with ${buyConfig.solAmount} SOL`}
                    >
                      {buyingTokens.has(s.token_address) ? 'Buying...' : 'Buy'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>
        </>
      )}

      {/* Floating Charts - Only draggable charts that are outside grid */}
      {floatingCharts
        .filter(chart => chart.isDraggable && !chart.isInGrid)
        .map((chart) => (
          <Draggable
            key={chart.id}
            defaultPosition={chart.position}
            onStart={() => handleDragStart(chart.id)}
            onStop={(e, data) => handleDragStop(chart.id, data)}
            handle=".drag-handle"
          >
            <div 
              className="fixed bg-white border-2 border-gray-300 rounded-lg shadow-2xl"
              style={{ 
                width: '480px', 
                height: '320px',
                zIndex: chart.zIndex
              }}
            >
              {/* Header with close button and buy controls */}
              <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg drag-handle cursor-move">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-gray-800">{chart.tokenSymbol || "UNKNOWN"}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">{buyConfig.solAmount} SOL</span>
                    <button
                      onClick={() => handleBuyToken(chart.tokenAddress, chart.tokenSymbol)}
                      disabled={buyingTokens.has(chart.tokenAddress)}
                      className={`px-3 py-1 rounded text-sm font-medium ${
                        buyingTokens.has(chart.tokenAddress)
                          ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                          : 'bg-green-500 hover:bg-green-600 text-white cursor-pointer'
                      }`}
                    >
                      {buyingTokens.has(chart.tokenAddress) ? 'Buying...' : 'Buy'}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => handleCloseChart(chart.id)}
                  className="text-gray-500 hover:text-gray-700 text-xl font-bold"
                >
                  ×
                </button>
              </div>

              {/* Chart iframe */}
              <iframe
                src={`https://gmgn.ai/sol/token/${chart.tokenAddress}`}
                className="w-full h-full rounded-b-lg"
                style={{ 
                  height: 'calc(100% - 60px)',
                  display: chart.isLoading ? 'none' : 'block' 
                }}
                title={`GMGN Chart - ${chart.tokenAddress}`}
                onLoad={() => handleChartLoad(chart.id)}
                onError={() => handleChartError(chart.id)}
                allowFullScreen
                frameBorder="0"
              />
            </div>
          </Draggable>
        ))
      }
    </div>
  )
}