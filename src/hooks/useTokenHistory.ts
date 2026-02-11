import { useQuery, keepPreviousData } from '@tanstack/react-query';

export interface TokenHistoryParams {
  page: number;
  limit: number;
  date?: string;
  search?: string;
}

export interface TokenHistoryResponse {
  tokens: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function useTokenHistory(params: TokenHistoryParams) {
  return useQuery({
    queryKey: ['token-history', params],
    queryFn: async () => {
      const searchParams = new URLSearchParams();
      searchParams.set('page', params.page.toString());
      searchParams.set('limit', params.limit.toString());
      if (params.date) searchParams.set('date', params.date);
      if (params.search) searchParams.set('search', params.search);

      const res = await fetch(`/api/trending/tokens?${searchParams.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to fetch token history');
      }
      return res.json() as Promise<TokenHistoryResponse>;
    },
    placeholderData: keepPreviousData,
  });
}
