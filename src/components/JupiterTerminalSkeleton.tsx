import React from 'react'

interface JupiterTerminalSkeletonProps {
  className?: string
}

const JupiterTerminalSkeleton: React.FC<JupiterTerminalSkeletonProps> = ({ 
  className = '' 
}) => {
  return (
    <div className={`rounded-2xl p-6 w-full max-w-2xl mx-auto bg-gray-900 border border-gray-700 animate-pulse ${className}`} 
         style={{ height: "500px", paddingTop: "50px" }}>
      
      {/* Header section */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="h-6 bg-gray-700 rounded w-24"></div>
          <div className="h-8 bg-gray-700 rounded w-20"></div>
        </div>
      </div>

      {/* From token section */}
      <div className="mb-4">
        <div className="h-4 bg-gray-700 rounded w-16 mb-2"></div>
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-gray-600 rounded-full"></div>
              <div>
                <div className="h-4 bg-gray-600 rounded w-12 mb-1"></div>
                <div className="h-3 bg-gray-700 rounded w-20"></div>
              </div>
            </div>
            <div className="text-right">
              <div className="h-6 bg-gray-600 rounded w-24 mb-1"></div>
              <div className="h-3 bg-gray-700 rounded w-16"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Swap arrow */}
      <div className="flex justify-center mb-4">
        <div className="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center">
          <div className="w-4 h-4 bg-gray-600 rounded"></div>
        </div>
      </div>

      {/* To token section */}
      <div className="mb-6">
        <div className="h-4 bg-gray-700 rounded w-12 mb-2"></div>
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-gray-600 rounded-full"></div>
              <div>
                <div className="h-4 bg-gray-600 rounded w-16 mb-1"></div>
                <div className="h-3 bg-gray-700 rounded w-24"></div>
              </div>
            </div>
            <div className="text-right">
              <div className="h-6 bg-gray-600 rounded w-20 mb-1"></div>
              <div className="h-3 bg-gray-700 rounded w-12"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Route info section */}
      <div className="mb-6">
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 bg-gray-700 rounded w-20"></div>
            <div className="h-4 bg-gray-700 rounded w-16"></div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <div className="h-3 bg-gray-700 rounded w-24"></div>
              <div className="h-3 bg-gray-700 rounded w-16"></div>
            </div>
            <div className="flex justify-between">
              <div className="h-3 bg-gray-700 rounded w-20"></div>
              <div className="h-3 bg-gray-700 rounded w-12"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Swap button */}
      <div className="w-full">
        <div className="h-12 bg-gray-700 rounded-xl w-full"></div>
      </div>

      {/* Settings and slippage */}
      <div className="flex justify-between items-center mt-4">
        <div className="h-4 bg-gray-700 rounded w-16"></div>
        <div className="flex space-x-2">
          <div className="w-8 h-8 bg-gray-700 rounded"></div>
          <div className="w-8 h-8 bg-gray-700 rounded"></div>
        </div>
      </div>
    </div>
  )
}

export default JupiterTerminalSkeleton