'use client'

import TokenLocateList from '@/components/token-locate/TokenLocateList'
import TokenMapBoard from '@/components/token-locate/TokenMapBoard'
import TokenMapPins from '@/components/token-locate/TokenMapPins'
import type { TokenLocateResult } from '@/strategies/token-locate'
import type { TokenMapActivityItem } from '@/strategies/token-map-activity'
import { isValidMintAddress } from '@/utils/jupiter'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type LocateResponse = TokenLocateResult & { success: boolean; error?: string; cached?: boolean }
type TokenView = 'freeview' | 'list'

type Pin = { address: string; symbol?: string | null }

const PINS_KEY = 'token-map-pins'
const VIEW_PREF_KEY = 'token-map-view'

function readViewFromUrl(): TokenView | null {
  if (typeof window === 'undefined') return null
  const v = new URL(window.location.href).searchParams.get('view')
  if (v === 'freeview' || v === 'list') return v
  return null
}

function readViewPref(): TokenView {
  if (typeof window === 'undefined') return 'list'
  const fromUrl = readViewFromUrl()
  if (fromUrl) return fromUrl
  try {
    const stored = localStorage.getItem(VIEW_PREF_KEY)
    if (stored === 'freeview' || stored === 'list') return stored
  } catch {
    /* ignore */
  }
  return 'list'
}

function loadPins(): Pin[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(PINS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Pin[]
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.address === 'string' && isValidMintAddress(p.address))
      : []
  } catch {
    return []
  }
}

function savePins(pins: Pin[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    /* ignore */
  }
}

function syncUrl(address: string, view: TokenView): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (address) url.searchParams.set('address', address)
  else url.searchParams.delete('address')
  url.searchParams.set('view', view)
  window.history.replaceState(null, '', url.toString())
}

type TokenLocateHubProps = {
  initialAddress?: string
  initialView?: TokenView
}

export default function TokenLocateHub({
  initialAddress = '',
  initialView,
}: TokenLocateHubProps) {
  const [address, setAddress] = useState(initialAddress)
  const [activeMint, setActiveMint] = useState(initialAddress.trim())
  const [view, setView] = useState<TokenView>(initialView ?? 'list')
  const viewRef = useRef(view)
  viewRef.current = view
  const [pins, setPins] = useState<Pin[]>([])
  const [manualLoading, setManualLoading] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const [manualResult, setManualResult] = useState<LocateResponse | null>(null)
  const seenIdsRef = useRef<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    setView(initialView ?? readViewPref())
    setPins(loadPins())
  }, [initialView])

  const setViewAndPersist = useCallback((next: TokenView) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_PREF_KEY, next)
    } catch {
      /* ignore */
    }
    syncUrl(activeMint, next)
  }, [activeMint])

  const runSearch = useCallback(async (mint: string, refresh = false) => {
    const trimmed = mint.trim()
    if (!isValidMintAddress(trimmed)) {
      setManualError('Enter a valid Solana mint address')
      setManualResult(null)
      return
    }
    setManualLoading(true)
    setManualError(null)
    try {
      const params = new URLSearchParams({ address: trimmed })
      if (refresh) params.set('refresh', 'true')
      const res = await fetch(`/api/strategies/token-locate?${params.toString()}`)
      const json = (await res.json()) as LocateResponse
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Lookup failed')
      }
      setManualResult(json)
      setActiveMint(trimmed)
      setAddress(trimmed)
      syncUrl(trimmed, viewRef.current)
      setPins((prev) => {
        const idx = prev.findIndex((p) => p.address === trimmed)
        if (idx < 0) return prev
        const next = [...prev]
        next[idx] = { ...next[idx], symbol: json.symbol }
        savePins(next)
        return next
      })
    } catch (e) {
      setManualError(e instanceof Error ? e.message : 'Lookup failed')
      setManualResult(null)
    } finally {
      setManualLoading(false)
    }
  }, [])

  useEffect(() => {
    const trimmed = initialAddress.trim()
    if (!isValidMintAddress(trimmed)) return
    const timer = window.setTimeout(() => {
      void runSearch(trimmed)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [initialAddress, runSearch])

  const freeviewEnabled = view === 'freeview' && isValidMintAddress(activeMint)

  const locateQuery = useQuery({
    queryKey: ['token-locate', activeMint],
    queryFn: async (): Promise<LocateResponse> => {
      const params = new URLSearchParams({ address: activeMint })
      const res = await fetch(`/api/strategies/token-locate?${params.toString()}`)
      const json = (await res.json()) as LocateResponse
      if (!res.ok || !json.success) throw new Error(json.error || 'Lookup failed')
      return json
    },
    enabled: freeviewEnabled,
    refetchInterval: freeviewEnabled ? 30_000 : false,
    staleTime: 15_000,
  })

  const activityQuery = useQuery({
    queryKey: ['token-activity', activeMint],
    queryFn: async (): Promise<TokenMapActivityItem[]> => {
      const params = new URLSearchParams({ address: activeMint, hours: '24' })
      const res = await fetch(`/api/strategies/token-activity?${params.toString()}`)
      const json = (await res.json()) as {
        success: boolean
        activities?: TokenMapActivityItem[]
        error?: string
      }
      if (!res.ok || !json.success) throw new Error(json.error || 'Activity fetch failed')
      return json.activities ?? []
    },
    enabled: freeviewEnabled,
    refetchInterval: freeviewEnabled ? 15_000 : false,
    staleTime: 10_000,
  })

  const activities = activityQuery.data ?? []

  useEffect(() => {
    if (!freeviewEnabled || activities.length === 0) return
    const seen = seenIdsRef.current
    const fresh = new Set<string>()
    for (const item of activities) {
      if (!seen.has(item.id)) fresh.add(item.id)
      seen.add(item.id)
    }
    if (fresh.size === 0) return
    setNewIds(fresh)
    const t = window.setTimeout(() => setNewIds(new Set()), 4000)
    return () => window.clearTimeout(t)
  }, [activities, freeviewEnabled, activeMint])

  useEffect(() => {
    seenIdsRef.current = new Set()
    setNewIds(new Set())
  }, [activeMint])

  const result: LocateResponse | null = useMemo(() => {
    if (view === 'freeview') return locateQuery.data ?? manualResult
    return manualResult
  }, [view, locateQuery.data, manualResult])

  const loading =
    manualLoading || (freeviewEnabled && locateQuery.isLoading && !result)
  const error =
    manualError ||
    (freeviewEnabled && locateQuery.error
      ? locateQuery.error instanceof Error
        ? locateQuery.error.message
        : String(locateQuery.error)
      : null)

  const isPinned = pins.some((p) => p.address === activeMint)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void runSearch(address)
  }

  const pinActive = () => {
    if (!result || !isValidMintAddress(result.tokenAddress)) return
    setPins((prev) => {
      if (prev.some((p) => p.address === result.tokenAddress)) return prev
      const next = [...prev, { address: result.tokenAddress, symbol: result.symbol }]
      savePins(next)
      return next
    })
  }

  const unpin = (mint: string) => {
    setPins((prev) => {
      const next = prev.filter((p) => p.address !== mint)
      savePins(next)
      return next
    })
  }

  const selectPin = (mint: string) => {
    setAddress(mint)
    setActiveMint(mint)
    syncUrl(mint, view)
    if (view === 'list') void runSearch(mint)
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Paste token mint address…"
          className="min-w-[16rem] flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-sm text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
        {result ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void runSearch(activeMint || address, true)}
            className="rounded-lg border border-gray-600 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Refresh
          </button>
        ) : null}

        <div className="flex overflow-hidden rounded-lg border border-gray-600">
          <button
            type="button"
            onClick={() => setViewAndPersist('freeview')}
            className={`px-3 py-2 text-sm ${
              view === 'freeview'
                ? 'bg-gray-700 text-white'
                : 'bg-gray-900 text-gray-400 hover:text-white'
            }`}
          >
            Freeview
          </button>
          <button
            type="button"
            onClick={() => setViewAndPersist('list')}
            className={`px-3 py-2 text-sm ${
              view === 'list'
                ? 'bg-gray-700 text-white'
                : 'bg-gray-900 text-gray-400 hover:text-white'
            }`}
          >
            List
          </button>
        </div>

        {result ? (
          <button
            type="button"
            onClick={isPinned ? () => unpin(result.tokenAddress) : pinActive}
            className="rounded-lg border border-gray-600 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800"
          >
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
        ) : null}
      </form>

      <TokenMapPins
        pins={pins}
        activeAddress={activeMint}
        onSelect={selectPin}
        onUnpin={unpin}
      />

      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-red-300">
          {error}
        </div>
      ) : null}

      {result && view === 'list' ? <TokenLocateList result={result} /> : null}

      {result && view === 'freeview' ? (
        <div className="space-y-2">
          {activityQuery.isError ? (
            <p className="text-xs text-amber-400">
              Activity feed unavailable:{' '}
              {activityQuery.error instanceof Error
                ? activityQuery.error.message
                : String(activityQuery.error)}
            </p>
          ) : null}
          <TokenMapBoard
            result={result}
            activities={activities}
            newIds={newIds}
          />
        </div>
      ) : null}

      {!result && !loading && !error ? (
        <p className="text-sm text-gray-500">
          Search a mint, then toggle <span className="text-gray-300">Freeview</span> for strategy
          lanes or <span className="text-gray-300">List</span> for the full locate dump.
        </p>
      ) : null}
    </div>
  )
}
