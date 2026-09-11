'use client';

import { FC } from "react";
import Link from "next/link";
import UniversalWalletButton from '@/components/UniversalWalletButton'
import { useWalletAddress } from '@/components/WalletProvider';
import { FaFire } from 'react-icons/fa';
import { useDailyStreak } from '@/hooks/useDailyStreak';

interface HeaderProps {
  onOpenDailyStreak?: () => void;
}

const Header: FC<HeaderProps> = ({ onOpenDailyStreak }) => {
  const walletAddress = useWalletAddress() ?? undefined;
  const { streak } = useDailyStreak(walletAddress);

  return (
    <header className="w-full border-b border-white/30 backdrop-blur-sm bg-black/80 relative z-40">
      <div className="container h-20 flex items-center max-w-4xl justify-between px-4 mx-auto">
        <Link href="/" className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300 md:text-2xl text-xl">
          ReloadSOL
        </Link>

        <div className="flex items-center gap-6">
          {walletAddress && (
            <button
              onClick={onOpenDailyStreak}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-4 py-1 md:py-2 rounded-full
                         bg-gradient-to-r from-orange-500/20 to-red-500/10
                         border border-orange-400/30 hover:border-orange-400/60 hover:bg-orange-500/10
                         transition-colors duration-200 group text-xs md:text-base"
            >
              <FaFire className="w-3 h-3 md:w-4 md:h-4 text-orange-400" />
              <span className="font-bold text-white">
                {streak} Day Streak
              </span>
            </button>
          )}
          <UniversalWalletButton />
        </div>
      </div>
    </header>
  );
};

export default Header;
