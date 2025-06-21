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
  const [lastReload, setLastReload] = useState<LastReloadData | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string>('')

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
          setLastReload(null);
          setError('');
          return;
        }
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result: LastReloadData = await response.json();
      setLastReload(result);
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

  const formatTimeAgo = (dateString: string): string => {
    const now = new Date();
    const operationTime = new Date(dateString);
    const diffMs = now.getTime() - operationTime.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const getOperationIcon = (operationType: 'swap' | 'close') => {
    return operationType === 'swap' ? '🔄' : '🔒';
  };

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

  if (!lastReload) {
    return (
      <div className={`bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-4 ${className}`}>
        <div className="text-center">
          <p className="text-gray-400 text-sm">No recent operations found</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-center space-x-3">
        <div className="flex-1 min-w-0 text-center">
          <div className="flex items-center justify-center space-x-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-gray-300 text-sm font-mono">
              {lastReload.shortWallet}
            </span>
            <span className="text-gray-300 text-sm">
              just reloaded
            </span>
            <span className="text-white font-mono text-sm font-semibold">
              {lastReload.totalSolRecovered.toFixed(4)} SOL
            </span>
          </div>
        </div>
      </div>
    </div>
  );
} 