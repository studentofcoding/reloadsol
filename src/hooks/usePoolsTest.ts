import { useQuery } from '@tanstack/react-query';

export interface PoolTestResult {
  poolId: string;
  symbol: string;
  tokenAge: {
    ageInDays: number;
    ageCategory: "NEW" | "RECENT" | "ESTABLISHED" | "OLD";
    ageDisplay: string;
    createdAt: string;
  };
  marketCap: number | null;
  buyTest: {
    success: boolean;
    bestProvider?: string;
    outputAmount?: string;
    responseTime?: number;
    priceComparison?: {
      providers: Record<
        string,
        {
          success: boolean;
          outputAmount: string;
          priceImpact: string;
          fee?: {
            totalFeeLamports: number;
            feePercentage: number;
          };
          responseTime: number;
          error?: string;
        }
      >;
      bestPrice: {
        provider: string;
        outputAmount: string;
        advantage: string;
      };
      worstPrice: {
        provider: string;
        outputAmount: string;
        disadvantage: string;
      };
      avgPriceImpact: string;
      priceSpread: string;
    };
    providers: Record<string, { success: boolean; error?: string }>;
  };
  sellTest: {
    success: boolean;
    bestProvider?: string;
    outputAmount?: string;
    responseTime?: number;
    priceComparison?: {
      providers: Record<
        string,
        {
          success: boolean;
          outputAmount: string;
          priceImpact: string;
          fee?: {
            totalFeeLamports: number;
            feePercentage: number;
          };
          responseTime: number;
          error?: string;
        }
      >;
      bestPrice: {
        provider: string;
        outputAmount: string;
        advantage: string;
      };
      worstPrice: {
        provider: string;
        outputAmount: string;
        disadvantage: string;
      };
      avgPriceImpact: string;
      priceSpread: string;
    };
    providers: Record<string, { success: boolean; error?: string }>;
  };
  liquidity: number | null;
  errors: string[];
}

export interface ComprehensiveTestResults {
  testType?: "comprehensive";
  summary: {
    totalPools: number;
    successfulBuyTests: number;
    successfulSellTests: number;
    averageResponseTime: number;
    providerPerformance: Record<
      string,
      { successes: number; failures: number; avgResponseTime: number }
    >;
    priceAnalysis: {
      avgBuyPriceSpread: string;
      avgSellPriceSpread: string;
      avgBuyPriceImpact: string;
      avgSellPriceImpact: string;
      bestBuyProvider: string;
      bestSellProvider: string;
    };
  };
  results: PoolTestResult[];
  providerHealth: Record<string, boolean>;
}

export interface StressTestResults {
  testType: "stress";
  summary: {
    totalPools: number;
    totalRequests: number;
    successfulRequests: number;
    averageResponseTime: number;
    concurrentRequests: number;
  };
  results: Array<{
    poolId: string;
    symbol: string;
    requests: Array<{
      success: boolean;
      responseTime: number;
      error?: string;
    }>;
    successRate: number;
    averageResponseTime: number;
  }>;
}

export interface BenchmarkTestResults {
  testType: "benchmark";
  summary: {
    totalIterations: number;
    testPool: string;
    averageResponseTime: number;
    fastestProvider: string;
    slowestProvider: string;
  };
  results: {
    providerPerformance: Record<
      string,
      {
        averageResponseTime: number;
        successRate: number;
        iterations: number;
      }
    >;
    iterations: Array<{
      iteration: number;
      providers: Record<
        string,
        {
          success: boolean;
          responseTime: number;
          error?: string;
        }
      >;
    }>;
  };
}

export type TestResults =
  | ComprehensiveTestResults
  | StressTestResults
  | BenchmarkTestResults;

export type TestType = "comprehensive" | "stress" | "benchmark";

interface UsePoolsTestParams {
  testType: TestType;
}

export function usePoolsTest({ testType }: UsePoolsTestParams) {
  return useQuery({
    queryKey: ['pools-test', testType],
    queryFn: async () => {
      const response = await fetch(`/api/trade/pools-test?type=${testType}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.result as TestResults;
    },
    enabled: false, // Don't fetch on mount
    staleTime: 0, // Always fetch fresh data when triggered
  });
}
