import React, { useEffect, useState } from 'react';
import { formatRiskDisplay, calculateFeeToMarketCapRatio } from '@/utils/axiom';
import { useAxiomRisk } from '@/hooks/useAxiomRisk';

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
  axiomData?: AxiomTokenInfo;
  riskData?: RiskIndicators;
  defaultExpanded?: boolean;
}

const RiskBadge: React.FC<{ riskLevel: RiskLevel }> = ({ riskLevel }) => {
  const display = formatRiskDisplay(riskLevel);
  return (
    <span 
      className={`px-1 py-0.5 rounded text-xs font-medium`}
      style={{ 
        backgroundColor: display.bg.replace('bg-', '').replace('-900/20', '').includes('red') ? 'rgba(239, 68, 68, 0.2)' :
                         display.bg.replace('bg-', '').replace('-900/20', '').includes('yellow') ? 'rgba(245, 158, 11, 0.2)' :
                         'rgba(34, 197, 94, 0.2)',
        color: display.color,
        border: `1px solid ${display.color}30`
      }}
    >
      {riskLevel}
    </span>
  );
};

export default function RiskAnalysis({ 
  tokenAddress, 
  marketCap, 
  onLoad, 
  axiomData: propAxiomData, 
  riskData: propRiskData,
  defaultExpanded = false 
}: RiskAnalysisProps) {
  const hasPropData = !!(propAxiomData && propRiskData);
  const query = useAxiomRisk(tokenAddress, marketCap, !hasPropData);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const onLoadCalledRef = React.useRef(false);

  const axiomData = hasPropData ? propAxiomData! : query.data?.axiomData ?? null;
  const risk = hasPropData ? propRiskData! : query.data?.risk ?? null;
  const isLoading = !hasPropData && query.isLoading;
  const error = !hasPropData && query.isError ? 'Failed to load risk data' : null;

  useEffect(() => {
    if ((axiomData && risk) && onLoad && !onLoadCalledRef.current) {
      onLoadCalledRef.current = true;
      onLoad();
    }
  }, [axiomData, risk, onLoad]);

  useEffect(() => {
    onLoadCalledRef.current = false;
  }, [tokenAddress]);

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  if (isLoading) {
    return <div className="text-xs text-gray-400">Loading risk analysis...</div>;
  }

  if (error || !axiomData || !risk) {
    return <div className="text-xs text-gray-400">{error || 'No risk data available'}</div>;
  }

  const feeToMcap = calculateFeeToMarketCapRatio(axiomData.totalPairFeesPaid, marketCap);
  
  const calculateOrganicScore = () => {
    let score = 100;
    if (risk.insiderRisk === 'HIGH') score -= 25;
    else if (risk.insiderRisk === 'MEDIUM') score -= 15;
    
    if (risk.bundlerRisk === 'HIGH') score -= 20;
    else if (risk.bundlerRisk === 'MEDIUM') score -= 10;
    
    if (risk.sniperRisk === 'HIGH') score -= 15;
    else if (risk.sniperRisk === 'MEDIUM') score -= 8;
    
    if (risk.concentrationRisk === 'HIGH') score -= 20;
    else if (risk.concentrationRisk === 'MEDIUM') score -= 10;
    
    if (risk.feeRisk === 'HIGH') score -= 20;
    else if (risk.feeRisk === 'MEDIUM') score -= 10;
    
    return Math.max(0, score);
  };

  const organicScore = calculateOrganicScore();

  return (
    <div className="text-xs">
      <div 
        className="flex items-center justify-between cursor-pointer hover:bg-gray-800/50 rounded px-1 py-0.5 transition-colors"
        onClick={toggleExpanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Risk:</span>
          <RiskBadge riskLevel={risk.overallRisk} />
          <span className="text-gray-500 text-xs">
            {organicScore}/100
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-500 text-xs">
            {risk.overallRisk === 'HIGH' ? '⚠️' : risk.overallRisk === 'MEDIUM' ? '⚡' : '✅'}
          </span>
          <svg 
            className={`w-3 h-3 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
        <div className="space-y-1 pt-2 border-t border-gray-700/50 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Insiders: {axiomData.insidersHoldPercent.toFixed(1)}%</span>
            <RiskBadge riskLevel={risk.insiderRisk} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Bundlers: {axiomData.bundlersHoldPercent.toFixed(1)}%</span>
            <RiskBadge riskLevel={risk.bundlerRisk} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Snipers: {axiomData.snipersHoldPercent.toFixed(1)}%</span>
            <RiskBadge riskLevel={risk.sniperRisk} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Top 10: {axiomData.top10HoldersPercent.toFixed(1)}%</span>
            <RiskBadge riskLevel={risk.concentrationRisk} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Fees/MCap:</span>
            <span className="text-white">{feeToMcap.ratio.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Organic Score:</span>
            <span className={`font-medium ${organicScore >= 70 ? 'text-green-400' : organicScore >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
              {organicScore}/100
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Holders:</span>
            <span className="text-white">{axiomData.numHolders.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Fees:</span>
            <span className="text-white">{axiomData.totalPairFeesPaid.toFixed(1)} SOL</span>
          </div>
        </div>
      </div>
    </div>
  );
}
