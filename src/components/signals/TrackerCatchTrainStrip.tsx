export function TrackerCatchTrainStrip({
  catchCount,
  catchOnly,
  onToggleCatchOnly,
  catchTrainSort,
  onCatchTrainSort,
}: {
  catchCount: number
  catchOnly: boolean
  onToggleCatchOnly: () => void
  catchTrainSort: boolean
  onCatchTrainSort: () => void
}) {
  return (
    <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-800/60 bg-gray-800/95 px-4 py-3 backdrop-blur">
      <span className="text-sm text-emerald-200">
        <span className="font-semibold">{catchCount}</span> catch
        <span className="text-gray-400"> on this page</span>
      </span>
      <button
        type="button"
        onClick={onCatchTrainSort}
        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
          catchTrainSort
            ? 'bg-emerald-600 text-white'
            : 'bg-gray-700 hover:bg-gray-600 text-gray-100'
        }`}
      >
        Catch train
      </button>
      <button
        type="button"
        onClick={onToggleCatchOnly}
        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
          catchOnly
            ? 'bg-emerald-700 text-white'
            : 'bg-gray-700 hover:bg-gray-600 text-gray-100'
        }`}
      >
        catch only
      </button>
    </div>
  )
}
