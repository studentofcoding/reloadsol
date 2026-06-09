'use client';

import { FC, useContext } from "react";
import Link from "next/link";
import UniversalWalletButton from '@/components/UniversalWalletButton'
// import TrendingTokens from "@/components/TrendingTokens";
import UserContext from "@/context/usercontext";
import { useDevWalletAccess, useWalletAddress } from '@/components/WalletProvider';
import { FaExchangeAlt, FaFire } from 'react-icons/fa';
import { useDailyStreak } from '@/hooks/useDailyStreak';


interface HeaderProps {
  onOpenDailyStreak?: () => void;
}

const Header: FC<HeaderProps> = ({ onOpenDailyStreak }) => {
  const walletAddress = useWalletAddress() ?? undefined;
  const isDevUser = useDevWalletAccess();

  // Replace points with daily streak
  const { streak } = useDailyStreak(walletAddress);

  return (
    <>
      <header className="w-full border-b border-white/30 backdrop-blur-sm bg-black/80 relative z-40">
        <div className="container h-20 flex items-center max-w-4xl justify-between px-4 mx-auto">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300 hidden md:block">
              ReloadSOL
            </Link>
            
            {/* Mobile logo */}
            <Link href="/" className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300 md:hidden">
              ReloadSOL
            </Link>
            
            {/* Navigation Links */}
            <nav className="hidden md:flex items-center gap-4">
              <Link 
                href="https://v2.reloadsol.xyz/buy"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-all duration-300"
              >
                <FaExchangeAlt className="w-4 h-4" />
                <span>Trade</span>
              </Link>
            </nav>
            
            {/* Mobile Trade Link */}
            <Link 
              href="https://v2.reloadsol.xyz/buy"
              target="_blank"
              rel="noopener noreferrer"
              className="md:hidden flex items-center gap-1 px-2 py-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-all duration-300"
            >
              <FaExchangeAlt className="w-4 h-4" />
            </Link>
          </div>

          <div className="flex items-center gap-6">
            
            {walletAddress && (
              <button 
                onClick={onOpenDailyStreak}
                className="flex items-center gap-1 md:gap-2 px-2 md:px-4 py-1 md:py-2 rounded-full
                           bg-gradient-to-r from-orange-500/20 to-red-500/10
                           border border-orange-400/30 hover:border-orange-400/50
                           transition-all duration-300 group text-xs md:text-base hover:scale-105"
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
      {/* Removed LeaderboardPopup here (now accessible from left sidebar) */}
    </>
  );
};

export default Header;
