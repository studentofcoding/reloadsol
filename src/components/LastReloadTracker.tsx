'use client'

import React, { useState, useEffect } from 'react'

interface LastReloadData {
  walletAddress: string;
  totalSolRecovered: number;
  lastOperationTime: string;
  operationType: 'swap' | 'close';
  shortWallet: string;
}

interface LastReloadTrackerProps {
  className?: string;
  refreshInterval?: number; // in milliseconds
}

export default function LastReloadTracker({ 
  className = '', 
  refreshInterval = 30000 // 30 seconds default
}: LastReloadTrackerProps) {
  const [lastReloads, setLastReloads] = useState<LastReloadData[]>([])
  const [currentIndex, setCurrentIndex] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string>('')
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false)

  const fetchLastReload = async () => {
    try {
      const response = await fetch('/api/operations/last-reload', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          setLastReloads([]);
          setError('');
          return;
        }
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result: LastReloadData[] = await response.json();
      setLastReloads(result);
      setCurrentIndex(0); // Reset to first item when new data arrives
      setError('');
    } catch (err) {
      console.error('Failed to fetch last reload:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchLastReload();
  }, []);

  // Set up auto-refresh
  useEffect(() => {
    if (refreshInterval > 0) {
      const interval = setInterval(fetchLastReload, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [refreshInterval]);

  // Set up cycling through transactions every 2 seconds
  useEffect(() => {
    if (lastReloads.length > 1) {
      const cycleInterval = setInterval(() => {
        setIsTransitioning(true);
        setTimeout(() => {
          setCurrentIndex((prevIndex) => (prevIndex + 1) % lastReloads.length);
          setIsTransitioning(false);
        }, 150); // Brief transition delay
      }, 5000); // Change every 5 seconds

      return () => clearInterval(cycleInterval);
    }
  }, [lastReloads]);

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