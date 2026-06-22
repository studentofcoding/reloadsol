'use client'

import React, { useEffect, useState } from 'react'
import { useLastReload } from '@/hooks/useLastReload'

interface LastReloadTrackerProps {
  className?: string;
  refreshInterval?: number;
}

export default function LastReloadTracker({ 
  className = '', 
  refreshInterval = 30000
}: LastReloadTrackerProps) {
  const { data: lastReloads = [], isLoading: loading, error: queryError } = useLastReload(refreshInterval)
  const [currentIndex, setCurrentIndex] = useState<number>(0)
  const [prevReloadKey, setPrevReloadKey] = useState<string>("")
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false)
  const error = queryError instanceof Error ? queryError.message : ''

  const reloadKey = lastReloads.map((r) => r.lastOperationTime).join("|")
  if (reloadKey !== prevReloadKey) {
    setPrevReloadKey(reloadKey)
    if (currentIndex !== 0) {
      setCurrentIndex(0)
    }
  }

  useEffect(() => {
    if (lastReloads.length > 1) {
      const cycleInterval = setInterval(() => {
        setIsTransitioning(true);
        setTimeout(() => {
          setCurrentIndex((prevIndex) => (prevIndex + 1) % lastReloads.length);
          setIsTransitioning(false);
        }, 150);
      }, 5000);

      return () => clearInterval(cycleInterval);
    }
  }, [lastReloads.length]);

  if (loading) {
    return (
      <div className={`bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-4 ${className}`}>
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-gray-700 rounded-full animate-pulse"></div>
          <div className="flex-1">
            <div className="h-4 bg-gray-700 rounded animate-pulse mb-2"></div>
            <div className="h-3 bg-gray-700 rounded animate-pulse w-3/4"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-4 ${className}`}>
        <div className="text-center">
          <p className="text-red-400 text-sm">⚠️ {error}</p>
        </div>
      </div>
    );
  }

  if (!lastReloads || lastReloads.length === 0) {
    return (
      <div className={`${className}`}>
        <div className="text-center">
          <p className="text-gray-400 text-sm">No recent operations found</p>
        </div>
      </div>
    );
  }

  const currentReload = lastReloads[currentIndex];

  return (
    <div className={className}>
      <div className="flex items-center justify-center space-x-3 text-sm font-mono">
        <div className="flex-1 min-w-0 text-center">
          <div 
            className="flex items-center justify-center space-x-2"
          >
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <div className={`flex items-center justify-center space-x-2 transition-all duration-300 ${
              isTransitioning ? 'opacity-50 scale-95' : 'opacity-100 scale-100'
            }`}>
              <span className="text-gray-300 text-sm">
                {currentReload.shortWallet}
              </span>
              <span className="text-gray-300 text-sm">
                just reloaded
              </span>
              <span className="text-white text-sm font-semibold">
                {currentReload.totalSolRecovered.toFixed(4)} SOL
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
