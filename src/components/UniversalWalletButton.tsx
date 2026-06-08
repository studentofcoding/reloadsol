"use client";

import {
  UnifiedWalletButton,
  useUnifiedWallet,
  useUnifiedWalletContext,
} from "@jup-ag/wallet-adapter";

interface UniversalWalletButtonProps {
  variant?: "default" | "jupiter";
}

export default function UniversalWalletButton({
  variant = "default",
}: UniversalWalletButtonProps) {
  const { connected, connecting } = useUnifiedWallet();
  const { setShowModal } = useUnifiedWalletContext();

  if (variant === "jupiter") {
    return (
      <UnifiedWalletButton
        buttonClassName="!bg-white hover:!bg-gray-100 !text-black !border !border-gray-300 !rounded-lg !font-semibold !px-3 !py-3"
        currentUserClassName="!bg-black hover:!bg-gray-800 !text-white !border !border-gray-600 !rounded-lg !font-medium !px-4 !py-2"
      />
    );
  }

  if (connected) {
    return (
      <UnifiedWalletButton
        currentUserClassName="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
      />
    );
  }

  return (
    <button
      onClick={() => setShowModal(true)}
      disabled={connecting}
      className={`
        flex items-center justify-center space-x-2 px-3 py-3 rounded-lg font-semibold transition-all duration-200 border mx-auto
        ${
          connecting
            ? "bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500"
            : "bg-white hover:bg-gray-100 text-black border-gray-300 shadow-lg hover:shadow-xl"
        }
      `}
    >
      {connecting ? (
        <>
          <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
          <span>Connecting...</span>
        </>
      ) : (
        <>
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" />
          </svg>
          <span>Connect Wallet</span>
        </>
      )}
    </button>
  );
}
