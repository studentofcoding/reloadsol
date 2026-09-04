import FomoMirrorPanel from "@/components/social/FomoMirrorPanel";


export default function FomoLivePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">FOMO tape</h1>
      <p className="mb-6 text-sm text-gray-400">
        Live robinhoodtrenches.com fill mirror (fomo.family wallets on Robinhood).
        Cron worker <code className="text-gray-300">fomo_ws</code> writes{" "}
        <code className="text-gray-300">fomo_fills</code>.
      </p>
      <FomoMirrorPanel showPageLink={false} />
    </div>
  );
}
