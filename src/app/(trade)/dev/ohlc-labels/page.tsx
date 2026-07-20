import OhlcLabelsGallery from '@/components/signals/OhlcLabelsGallery'

export const dynamic = 'force-dynamic'

export default function OhlcLabelsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">OHLC labels</h1>
      <p className="mb-6 text-sm text-gray-400">
        Snapshots captured when a token is labeled Potential or Rugged on
        Signals. Potential windows are peak-first (≤10m); rug windows run from
        track start until stop.
      </p>
      <OhlcLabelsGallery />
    </div>
  )
}
