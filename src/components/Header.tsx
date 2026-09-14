'use client';

import { FC } from "react";
import Link from "next/link";
import UniversalWalletButton from '@/components/UniversalWalletButton'
import ClimateChip from '@/components/ClimateChip';
import { useWalletAddress } from '@/components/WalletProvider';
import { useAppNetwork } from '@/contexts/AppNetworkContext';
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet';
import { connectedSellPath } from '@/config/route-network';
import { chromeFloat, chromePrimary, insightPress } from '@/components/insight/insight-ui';
import { FaFire } from 'react-icons/fa';
import { useDailyStreak } from '@/hooks/useDailyStreak';

interface HeaderProps {
  onOpenDailyStreak?: () => void;
}

const Header: FC<HeaderProps> = ({ onOpenDailyStreak }) => {
  const walletAddress = useWalletAddress() ?? undefined;
  const { streak } = useDailyStreak(walletAddress);
  const { network } = useAppNetwork();
  const rh = useRhEvmWallet();
  const brandHref =
    connectedSellPath(Boolean(walletAddress), Boolean(rh.address), network) ??
    '/';

  return (
    <header className={chromeFloat} data-chrome="primary">
      <div className={chromePrimary}>
        <Link
          href={brandHref}
          className={`shrink-0 text-lg font-semibold tracking-tight text-neutral-900 md:text-xl ${insightPress}`}
        >
          ReloadSOL
        </Link>

        <div className="flex min-w-0 shrink-0 items-center gap-1.5 md:gap-3">
          {walletAddress && (
            <button
              type="button"
              onClick={onOpenDailyStreak}
              className={`flex items-center gap-1 rounded-full bg-orange-500/15 py-1 ps-1.5 pe-2 text-xs font-semibold text-orange-800 md:gap-1.5 md:ps-2 md:pe-3 ${insightPress} fine-hover:bg-orange-500/22`}
            >
              <FaFire className="h-3 w-3 text-orange-600 md:h-3.5 md:w-3.5" />
              <span className="tabular-nums">
                {streak} Day Streak
              </span>
            </button>
          )}
          <ClimateChip />
          <UniversalWalletButton surface="chrome" />
        </div>
      </div>
    </header>
  );
};

export default Header;
