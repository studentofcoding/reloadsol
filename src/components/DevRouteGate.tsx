"use client";

import { useDevWalletAccess } from "@/components/WalletProvider";

export default function DevRouteGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const isDevUser = useDevWalletAccess();

  if (!isDevUser) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-300">
        <p className="text-lg font-medium text-white">Dev access required</p>
        <p className="mt-2 text-sm text-gray-400">
          Connect a dev wallet to use this tool.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
