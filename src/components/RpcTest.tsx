'use client'

import { useState } from 'react'
import { useConnection } from './WalletProvider'
import { useRpcHealth } from '@/hooks/useRpcHealth'

export default function RpcTest() {
  const { connection } = useConnection()
  const { data: healthData, isFetching: isHealthLoading, refetch: refetchHealth, error: healthError } = useRpcHealth()
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState<string>('')

  const testConnection = async () => {
    if (!connection) {
      setError('❌ RPC connection not ready')
      return
    }

    setIsLoading(true)
    setError('')
    setResult('')
    
    try {
      const slot = await connection.getSlot()
      setResult(`✅ RPC Connection working! Current slot: ${slot}`)
    } catch (err) {
      console.error('RPC test failed:', err)
      setError(`❌ RPC test failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsLoading(false)
    }
  }

  const checkHealth = async () => {
    try {
      await refetchHealth()
    } catch (err) {
      console.error('Health check failed:', err)
      setError(`❌ Health check failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  const displayError = error || (healthError instanceof Error ? healthError.message : '')

  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl p-6 max-w-2xl">
      <h3 className="text-white font-semibold mb-4 text-lg">RPC Health Monitor</h3>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <button
          onClick={testConnection}
          disabled={isLoading}
          className="py-2 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white rounded-lg transition-colors"
        >
          {isLoading ? 'Testing Connection...' : 'Test RPC Connection'}
        </button>
        
        <button
          onClick={checkHealth}
          disabled={isHealthLoading}
          className="py-2 px-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 text-white rounded-lg transition-colors"
        >
          {isHealthLoading ? 'Checking Health...' : 'Check All Endpoints'}
        </button>
      </div>

      {healthData && (
        <div className="mb-4 p-4 bg-gray-700 rounded-lg">
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-white font-medium">Endpoint Health Summary</h4>
            <span className="text-xs text-gray-400">
              Updated: {new Date(healthData.timestamp).toLocaleTimeString()}
            </span>
          </div>
          
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-white">{healthData.summary.total}</div>
              <div className="text-gray-400">Total</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">{healthData.summary.healthy}</div>
              <div className="text-gray-400">Healthy</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">{healthData.summary.unhealthy}</div>
              <div className="text-gray-400">Unhealthy</div>
            </div>
          </div>
        </div>
      )}

      {healthData && healthData.endpoints.length > 0 && (
        <div className="mb-4">
          <h4 className="text-white font-medium mb-3">Endpoint Details</h4>
          <div className="space-y-2">
            {healthData.endpoints.map((endpoint: { url: string; healthy: boolean; responseTime: number; error?: string }, index: number) => (
              <div
                key={index}
                className={`p-3 rounded-lg border ${
                  endpoint.healthy
                    ? 'bg-green-900/20 border-green-500/30'
                    : 'bg-red-900/20 border-red-500/30'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className={`w-2 h-2 rounded-full ${endpoint.healthy ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="text-sm font-mono text-gray-300 break-all">
                        {endpoint.url.replace(/\?.*$/, '?***')}
                      </span>
                    </div>
                    {endpoint.error && (
                      <div className="text-xs text-red-300 mt-1 ml-4">
                        {endpoint.error}
                      </div>
                    )}
                  </div>
                  <div className="text-right ml-4">
                    <div className={`text-sm font-semibold ${endpoint.healthy ? 'text-green-400' : 'text-red-400'}`}>
                      {endpoint.healthy ? '✓' : '✗'}
                    </div>
                    <div className="text-xs text-gray-400">
                      {endpoint.responseTime}ms
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="mb-4 p-3 bg-green-900/30 border border-green-500/30 rounded text-green-200 text-sm">
          {result}
        </div>
      )}
      
      {displayError && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-500/30 rounded text-red-200 text-sm">
          {displayError}
        </div>
      )}
      
      <div className="text-xs text-gray-400 border-t border-gray-600 pt-3">
        <div>Current Connection: {connection?.rpcEndpoint ?? 'Not ready'}</div>
        <div className="mt-1">
          HTTP requests are automatically proxied through /api/rpc for CORS bypass.
        </div>
        <div className="mt-1">
          WebSocket connections use the direct RPC URL to avoid proxy issues.
        </div>
      </div>
    </div>
  )
}
