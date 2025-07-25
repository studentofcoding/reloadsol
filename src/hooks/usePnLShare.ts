'use client'

import { useState, useCallback } from 'react'
import { ShareData, PnLShareOptions, pnlShareService } from '@/utils/pnl-share-service'

export interface UsePnLShareReturn {
  shareData: ShareData | null
  isShareModalOpen: boolean
  isGeneratingShare: boolean
  showShareModal: (options: PnLShareOptions) => Promise<void>
  hideShareModal: () => void
  autoTriggerShare: (options: PnLShareOptions) => Promise<void>
}

export function usePnLShare(): UsePnLShareReturn {
  const [shareData, setShareData] = useState<ShareData | null>(null)
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [isGeneratingShare, setIsGeneratingShare] = useState(false)

  const showShareModal = useCallback(async (options: PnLShareOptions) => {
    setIsGeneratingShare(true)
    try {
      const data = await pnlShareService.prepareShareData(options)
      setShareData(data)
      setIsShareModalOpen(true)
    } catch (error) {
      console.error('Error preparing share data:', error)
    } finally {
      setIsGeneratingShare(false)
    }
  }, [])

  const hideShareModal = useCallback(() => {
    setIsShareModalOpen(false)
    setShareData(null)
  }, [])

  const autoTriggerShare = useCallback(async (options: PnLShareOptions) => {
    setIsGeneratingShare(true)
    try {
      const data = await pnlShareService.autoTriggerShare(options)
      setShareData(data)
      setIsShareModalOpen(true)

      // Auto-close after 10 seconds if user doesn't interact
      setTimeout(() => {
        setIsShareModalOpen(false)
      }, 10000)
    } catch (error) {
      console.error('Error auto-triggering share:', error)
    } finally {
      setIsGeneratingShare(false)
    }
  }, [])

  return {
    shareData,
    isShareModalOpen,
    isGeneratingShare,
    showShareModal,
    hideShareModal,
    autoTriggerShare
  }
}