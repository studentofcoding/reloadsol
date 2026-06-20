'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { DlmmPotentialSource } from '@/types/dlmm';
import type { TokenRugSource } from '@/types/rug-list';
import { useDlmmPotentialList } from '@/hooks/useDlmmPotentialList';
import { RUG_LIST_QUERY_KEY, useRugList } from '@/hooks/useRugList';

type ChartActionInput = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source: DlmmPotentialSource;
};

/** Potential + rug list actions shared across DLMM, Signals, and Algo Tester. */
export function useDlmmChartActions() {
  const queryClient = useQueryClient();
  const potential = useDlmmPotentialList();
  const rug = useRugList();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['dlmm-potential-list'] });
    queryClient.invalidateQueries({ queryKey: RUG_LIST_QUERY_KEY });
  };

  const markPotential = async (input: ChartActionInput) => {
    const { tokenAddress, tokenSymbol, source } = input;
    if (potential.isInList(tokenAddress)) {
      await potential.remove(tokenAddress);
      invalidateAll();
      return;
    }
    if (rug.isRugged(tokenAddress)) {
      await rug.unmarkRug(tokenAddress);
    }
    await potential.add({ tokenAddress, tokenSymbol, source });
    invalidateAll();
  };

  const markRug = async (input: ChartActionInput) => {
    const rugSource = input.source as TokenRugSource;
    await rug.toggleRug({
      tokenAddress: input.tokenAddress,
      tokenSymbol: input.tokenSymbol,
      source: rugSource,
    });
    invalidateAll();
  };

  return {
    isInPotential: potential.isInList,
    isRugged: rug.isRugged,
    markPotential,
    markRug,
    isPending: potential.isPending || rug.isPending,
    rugAddressSet: rug.addressSet,
    potentialAddressSet: potential.addressSet,
  };
}
