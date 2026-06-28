import SocialAdminHub from "@/components/social/SocialAdminHub";

export const dynamic = "force-dynamic";

export default function SocialAdminPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Social & wallet tracker</h1>
      <p className="mb-6 text-sm text-gray-400">
        Telegram mention rollups and curated smart-money wallets feeding signals / mcap sim-track
        and ML entry features. Sidecar: <code className="text-gray-300">social-ingest</code>.
      </p>
      <SocialAdminHub />
    </div>
  );
}
