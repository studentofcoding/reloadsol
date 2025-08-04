'use client'

export interface ShareData {
  coinName: string
  profitPercentage: number
  type: 'profit' | 'loss'
  tokenAddress?: string
  imageDataUrl?: string
  tweetText?: string
  copied?: boolean
}

export interface PnLShareOptions {
  coinName: string
  profitPercentage: number
  tokenAddress?: string
  solAmountBought?: number
  solAmountSold?: number
  customMessage?: string
}

export class PnLShareService {
  private canvas: HTMLCanvasElement | null = null

  constructor() {
    // Create a hidden canvas for image generation
    if (typeof window !== 'undefined') {
      this.canvas = document.createElement('canvas')
      this.canvas.style.display = 'none'
      document.body.appendChild(this.canvas)
    }
  }

  // Generate shareable image using the profit_share.png template
  async generateShareImage(coinName: string, profitPercentage: number, tokenAddress?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.canvas) {
        reject(new Error('Canvas not available'))
        return
      }

      const ctx = this.canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas context not available'))
        return
      }

      // Set canvas dimensions to match the template
      this.canvas.width = 1200
      this.canvas.height = 675

      // Load the base template image
      const baseImage = new Image()
      baseImage.crossOrigin = 'anonymous'

      baseImage.onload = () => {
        try {
          // Clear canvas and draw the base template
          ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height)
          ctx.drawImage(baseImage, 0, 0, this.canvas!.width, this.canvas!.height)

          const isProfit = profitPercentage > 0
          const pnlText = `${isProfit ? '+' : ''}${profitPercentage.toFixed(1)}%`
          const coinText = `$${coinName.toUpperCase()}`
          const statusText = isProfit ? 'PROFIT' : 'LOSS'

          // Position for middle-left area
          const baseX = 120
          const baseY = this.canvas!.height / 2

          // Helper function to draw text with background
          const drawTextWithBackground = (
            text: string,
            x: number,
            y: number,
            fontSize: number,
            textColor: string,
            bgColor: string,
            padding: number = 20
          ) => {
            // Set font for measurement
            ctx.font = `bold ${fontSize}px Arial, sans-serif`
            const metrics = ctx.measureText(text)
            const textWidth = metrics.width
            const textHeight = fontSize

            // Calculate background rectangle dimensions
            const bgWidth = textWidth + (padding * 2)
            const bgHeight = textHeight + (padding * 1.5)
            const bgX = x - padding
            const bgY = y - (textHeight / 2) - (padding * 0.75)

            // Draw shadow first (offset background)
            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
            ctx.fillRect(bgX + 4, bgY + 4, bgWidth, bgHeight)

            // Draw main background with gradient
            const gradient = ctx.createLinearGradient(bgX, bgY, bgX, bgY + bgHeight)
            gradient.addColorStop(0, bgColor)
            gradient.addColorStop(1, bgColor.replace('0.9', '0.7')) // Slightly more transparent at bottom

            ctx.fillStyle = gradient
            ctx.fillRect(bgX, bgY, bgWidth, bgHeight)

            // Draw border
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
            ctx.lineWidth = 2
            ctx.strokeRect(bgX, bgY, bgWidth, bgHeight)

            // Draw the text
            ctx.fillStyle = textColor
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
            ctx.lineWidth = 3
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'

            ctx.strokeText(text, x, y)
            ctx.fillText(text, x, y)
          }

          // Draw STATUS text with background (top)
          const statusY = baseY - 120
          const statusBgColor = isProfit ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)'
          drawTextWithBackground(
            statusText,
            baseX,
            statusY,
            28,
            '#FFFFFF',
            statusBgColor,
            15
          )

          // Draw PnL percentage with background (main focus)
          const pnlBgColor = isProfit ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.9)'
          drawTextWithBackground(
            pnlText,
            baseX,
            baseY,
            72,
            '#FFFFFF',
            pnlBgColor,
            25
          )

          // Draw coin name with background (below PnL)
          const coinY = baseY + 80
          drawTextWithBackground(
            coinText,
            baseX,
            coinY,
            36,
            '#FFFFFF',
            'rgba(55, 65, 81, 0.9)', // Dark gray background
            20
          )

          resolve(this.canvas!.toDataURL('image/png'))
        } catch (error) {
          console.error('Error generating share image:', error)
          reject(error)
        }
      }

      baseImage.onerror = () => {
        console.error('Failed to load profit_share.png template')
        // Fallback: create a simple colored background if template fails
        const isProfit = profitPercentage > 0
        ctx.fillStyle = isProfit ? '#065F46' : '#7F1D1D'
        ctx.fillRect(0, 0, this.canvas!.width, this.canvas!.height)

        // Add fallback text with background
        const fallbackText = `${profitPercentage > 0 ? '+' : ''}${profitPercentage.toFixed(1)}%`
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.fillRect(this.canvas!.width / 2 - 150, this.canvas!.height / 2 - 50, 300, 100)

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = 'bold 72px Arial, sans-serif'
        ctx.fillStyle = '#FFFFFF'
        ctx.fillText(fallbackText, this.canvas!.width / 2, this.canvas!.height / 2)

        resolve(this.canvas!.toDataURL('image/png'))
      }

      // Load the template image
      baseImage.src = '/profit_share.png'
    })
  }

  // Generate tweet text
  generateTweetText(options: PnLShareOptions): string {
    const { coinName, profitPercentage, tokenAddress, customMessage } = options
    const isProfit = profitPercentage > 0

    if (customMessage) {
      return customMessage
    }

    return `Just ${isProfit ? 'made' : 'took'} ${Math.abs(profitPercentage).toFixed(1)}% ${isProfit ? 'profit' : 'loss'} trading $${coinName}! 📈\n\n${tokenAddress ? `Trade here: https://v2.reloadsol.xyz/buy?mints=${tokenAddress}` : ''}\n\n #Solana #Trading #Crypto #reloadsol`
  }

  // Prepare share data
  async prepareShareData(options: PnLShareOptions): Promise<ShareData> {
    try {
      const imageDataUrl = await this.generateShareImage(options.coinName, options.profitPercentage, options.tokenAddress)
      const tweetText = this.generateTweetText(options)

      return {
        coinName: options.coinName,
        profitPercentage: options.profitPercentage,
        type: options.profitPercentage > 0 ? 'profit' : 'loss',
        tokenAddress: options.tokenAddress,
        imageDataUrl,
        tweetText
      }
    } catch (error) {
      console.error('Error preparing share data:', error)
      // Fallback: return data without image
      return {
        coinName: options.coinName,
        profitPercentage: options.profitPercentage,
        type: options.profitPercentage > 0 ? 'profit' : 'loss',
        tokenAddress: options.tokenAddress,
        tweetText: this.generateTweetText(options)
      }
    }
  }

  // Share to Twitter with mobile-first approach
  async shareToTwitter(shareData: ShareData): Promise<void> {
    if (!shareData.tweetText) return

    try {
      // Try Web Share API first (mobile native sharing)
      if (navigator.share && shareData.imageDataUrl) {
        try {
          // Convert data URL to blob for sharing
          const response = await fetch(shareData.imageDataUrl)
          const blob = await response.blob()
          const file = new File([blob], `${shareData.coinName}_trade.png`, { type: 'image/png' })

          const shareData_native = {
            title: `${shareData.coinName} Trade Result`,
            text: shareData.tweetText,
            files: [file]
          }

          if (navigator.canShare(shareData_native)) {
            await navigator.share(shareData_native)
            return
          }
        } catch (shareError) {
          console.log('Web Share API failed, falling back to Twitter intent')
        }
      }

      // Fallback: Twitter intent URL (works on all platforms)
      const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareData.tweetText)}`
      window.open(twitterUrl, '_blank', 'width=550,height=420,noopener,noreferrer')

    } catch (error) {
      console.error('Error sharing:', error)
      // Final fallback: just open Twitter
      window.open('https://twitter.com/intent/tweet', '_blank', 'noopener,noreferrer')
    }
  }

  // Copy tweet text to clipboard
  async copyTweetText(tweetText: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(tweetText)
      return true
    } catch (error) {
      console.error('Failed to copy text:', error)
      return false
    }
  }

  // Download image
  async downloadImage(shareData: ShareData): Promise<void> {
    if (!shareData.imageDataUrl) {
      console.error('No image data available for download')
      return
    }

    try {
      const link = document.createElement('a')
      link.download = `${shareData.coinName}_profit_share.png`
      link.href = shareData.imageDataUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error('Error downloading image:', error)
    }
  }

  // Calculate PnL percentage from SOL amounts
  calculatePnLPercentage(solAmountBought: number, solAmountSold: number): number {
    if (solAmountBought <= 0) return 0
    return ((solAmountSold - solAmountBought) / solAmountBought) * 100
  }

  // Auto-trigger share modal for successful sells
  async autoTriggerShare(options: PnLShareOptions): Promise<ShareData> {
    console.log(`🎯 Auto-triggering PnL share for ${options.coinName} with ${options.profitPercentage.toFixed(1)}% ${options.profitPercentage > 0 ? 'profit' : 'loss'}`)
    return await this.prepareShareData(options)
  }

  // Cleanup method
  destroy(): void {
    if (this.canvas && document.body.contains(this.canvas)) {
      document.body.removeChild(this.canvas)
      this.canvas = null
    }
  }
}

// Create a singleton instance
export const pnlShareService = new PnLShareService()

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    pnlShareService.destroy()
  })
}