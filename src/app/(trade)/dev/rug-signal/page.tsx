import RugSignalPanel from '@/components/signals/RugSignalPanel'

export default function RugSignalPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Rug signal — reachability &amp; soak</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-400">
        Two questions this page answers. <span className="text-gray-200">Can the trip fire at all?</span> Across
        the judged observations the best joint score has been 65/80 with a reachable pre-dump ceiling of 75, so
        the trip is currently <em>unreachable</em> — the volume band averages in a dispersion term that our
        trade-driven series cannot inform. <span className="text-gray-200">Is it right?</span> That is the soak&apos;s
        job, and it needs collapses and trips to both exist before precision means anything. The replay below
        re-scores the stored observations with the real scorer; it never writes a verdict.
      </p>
      <RugSignalPanel />
    </div>
  )
}
