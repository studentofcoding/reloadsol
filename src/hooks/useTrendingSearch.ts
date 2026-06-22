import { useQuery } from "@tanstack/react-query";

async function searchTrendingTokens(query: string) {
  const res = await fetch(
    `/api/trending/search?query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function useTrendingSearch(query: string, debounceMs = 300) {
  return useQuery({
    queryKey: ["trending-search", query],
    queryFn: () => searchTrendingTokens(query),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    meta: { debounceMs },
  });
}
