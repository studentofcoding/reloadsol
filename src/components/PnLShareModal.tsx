'use client'

import React from 'react'
import { ShareData, pnlShareService } from '@/utils/pnl-share-service'

interface PnLShareModalProps {
  isOpen: boolean
  onClose: () => void
  shareData: ShareData | null
  onCopySuccess?: () => void
}

export default function PnLShareModal({ isOpen, onClose, shareData, onCopySuccess }: PnLShareModalProps) {
  const [copied, setCopied] = React.useState(false)

  if (!isOpen || !shareData) return null

  const handleShareToTwitter = async () => {
    await pnlShareService.shareToTwitter(shareData)
    onClose()
  }

  const handleCopyText = async () => {
    if (!shareData.tweetText) return
    
    const success = await pnlShareService.copyTweetText(shareData.tweetText)
    if (success) {
      setCopied(true)
      onCopySuccess?.()
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = async () => {
    await pnlShareService.downloadImage(shareData)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-white">
              Share Your {shareData.type === 'profit' ? 'Profit' : 'Loss'} 🎯
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          {/* Generated Image Preview */}
          {shareData.imageDataUrl && (
            <div className="mb-4">
              <img 
                src={shareData.imageDataUrl} 
                alt="Trade result" 
                className="w-full rounded-lg border border-gray-600"
              />
            </div>
          )}
          
          {/* Tweet Text Preview */}
          {shareData.tweetText && (
            <div className="mb-4 p-3 bg-gray-700 rounded-lg">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">
                {shareData.tweetText}
              </p>
            </div>
          )}
          
          {/* Action Buttons */}
          <div className="space-y-3">
            {/* Share on Twitter Button */}
            <button
              onClick={handleShareToTwitter}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              <span>Share on X (Twitter)</span>
            </button>
            
            <div className="flex space-x-3">
              {/* Copy Text Button */}
              <button
                onClick={handleCopyText}
                className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors ${
                  copied 
                    ? 'bg-green-600 text-white' 
                    : 'bg-gray-600 hover:bg-gray-700 text-white'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={
                    copied 
                      ? "M5 13l4 4L19 7"
                      : "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  } />
                </svg>
                <span>{copied ? 'Copied!' : 'Copy Text'}</span>
              </button>
              
              {/* Download Button */}
              <button
                onClick={handleDownload}
                className="flex-1 py-2 px-4 rounded-lg flex items-center justify-center space-x-2 bg-gray-600 hover:bg-gray-700 text-white transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Download</span>
              </button>
            </div>
            
            {/* Mobile Instructions */}
            <div className="text-xs text-gray-400 text-center mt-4 md:hidden">
              💡 Tip: Use "Share on X" for best mobile experience
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}