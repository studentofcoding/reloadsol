import React, { useState, useEffect } from 'react';
import { fetchAxiomTokenInfo, getRiskIndicators, formatRiskDisplay, calculateFeeToMarketCapRatio } from '@/utils/axiom';

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

interface AxiomTokenInfo {
  numHolders: number;
  numBotUsers: number;
  top10HoldersPercent: number;
  devHoldsPercent: number;
  insidersHoldPercent: number;
  bundlersHoldPercent: number;
  snipersHoldPercent: number;
  dexPaid: boolean;
  totalPairFeesPaid: number;
}

interface RiskIndicators {
  insiderRisk: RiskLevel;
  bundlerRisk: RiskLevel;
  sniperRisk: RiskLevel;
  concentrationRisk: RiskLevel;
  feeRisk: RiskLevel;
  overallRisk: RiskLevel;
}

interface RiskAnalysisProps {
  tokenAddress: string;
  marketCap: number;
  onLoad?: () => void;
}

export default function RiskAnalysis({ tokenAddress, marketCap, onLoad }: RiskAnalysisProps) {
  const [axiomData, setAxiomData] = useState<AxiomTokenInfo | null>(null);
  const [risk, setRisk] = useState<RiskIndicators | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchAxiomTokenInfo(tokenAddress);
        if (result.success && result.data) {
          setAxiomData(result.data);
          const calculatedRisk = getRiskIndicators(result.data, marketCap);
          setRisk(calculatedRisk);
          onLoad?.();
        } else {
          setError('Failed to load risk data');
        }
      } catch (err) {
        setError('Error fetching risk data');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [tokenAddress, marketCap, onLoad]);

  if (isLoading) {
    return <div>Loading risk analysis...</div>;
  }

  if (error || !axiomData || !risk) {
    return <div>{error || 'No risk data available'}</div>;
  }

  const feeToMcap = calculateFeeToMarketCapRatio(axiomData.totalPairFeesPaid, marketCap);
  const organicScore = /* Calculate organic score based on risks */ 50; // Adjust based on actual logic

  return (
    <div className="text-xs">
      <div>Risk: {formatRiskDisplay(risk.overallRisk)}</div>
      <div>Insiders: {axiomData.insidersHoldPercent}% {formatRiskDisplay(risk.insiderRisk)}</div>
      <div>Bundlers: {axiomData.bundlersHoldPercent}% {formatRiskDisplay(risk.bundlerRisk)}</div>
      <div>Snipers: {axiomData.snipersHoldPercent}% {formatRiskDisplay(risk.sniperRisk)}</div>
      <div>Top 10: {axiomData.top10HoldersPercent}% {formatRiskDisplay(risk.concentrationRisk)}</div>
      <div>Organic Trading: ⚠️ Bundled {formatRiskDisplay(risk.feeRisk)}</div>
      <div>Fees/MCap Ratio: {feeToMcap.toFixed(2)} SOL/5K MC</div>
      <div>Organic Score: {organicScore}/100</div>
      <div>Holders: {axiomData.numHolders}</div>
      <div>Fees: {axiomData.totalPairFeesPaid.toFixed(1)} SOL</div>
    </div>
  );
}