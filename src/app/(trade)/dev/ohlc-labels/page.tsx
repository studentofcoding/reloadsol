import OhlcLabelsGallery from '@/components/signals/OhlcLabelsGallery'


export default function OhlcLabelsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">OHLC labels</h1>
      <p className="mb-6 text-sm text-gray-400">
        Training snapshots from Potential / Rugged labels: first 10 minutes of
        track OHLC, copied from Freeview detect snapshots when available
        (otherwise fetched once). List is Redis + browser cached for 10m.
      </p>
      <OhlcLabelsGallery />
    </div>
  )
}
