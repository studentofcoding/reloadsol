import DevReputationHub from '@/components/dev/DevReputationHub'

export default function DevReputationPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Dev reputation</h1>
      <p className="mb-6 text-sm text-gray-400">
        Profitable devs vs the ban list — each with their stats and top tokens by
        ATH (capped at 10). Shadow-first: verdicts do not gate anything yet.
      </p>
      <DevReputationHub />
    </div>
  )
}
