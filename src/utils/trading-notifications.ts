/**
 * Trading Notifications Utility
 * Handles real-time notifications for trading operations across devices
 */

interface NotificationData {
    operationType?: 'buy' | 'sell' | 'close'
    tokenAddress?: string
    tokenSymbol?: string
    amount?: number
    signature?: string
}

/**
 * Notify all connected devices about a trading update
 */
export async function notifyTradingUpdate(
    walletAddress: string,
    type: 'trade_update' | 'pnl_update' | 'balance_update',
    data?: NotificationData
) {
    try {
        // Get the base URL for the API call
        const baseUrl = typeof window !== 'undefined'
            ? window.location.origin
            : process.env.NEXTAUTH_URL || 'http://localhost:3000'

        const response = await fetch(`${baseUrl}/api/trading/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                walletAddress,
                type,
                data: {
                    ...data,
                    timestamp: new Date().toISOString()
                }
            })
        })

        if (!response.ok) {
            console.error('Failed to notify trading update:', await response.text())
            return false
        }

        const result = await response.json()
        console.log(`📡 Trading notification sent: ${result.notified} devices notified`)
        return true
    } catch (error) {
        console.error('Error sending trading notification:', error)
        return false
    }
}

/**
 * Convenience functions for specific notification types
 */
export const notifyBuyOperation = (
    walletAddress: string,
    tokenAddress: string,
    tokenSymbol: string,
    amount: number,
    signature?: string
) => notifyTradingUpdate(walletAddress, 'trade_update', {
    operationType: 'buy',
    tokenAddress,
    tokenSymbol,
    amount,
    signature
})

export const notifySellOperation = (
    walletAddress: string,
    tokenAddress: string,
    tokenSymbol: string,
    amount: number,
    signature?: string
) => notifyTradingUpdate(walletAddress, 'trade_update', {
    operationType: 'sell',
    tokenAddress,
    tokenSymbol,
    amount,
    signature
})

export const notifyPnLUpdate = (walletAddress: string) =>
    notifyTradingUpdate(walletAddress, 'pnl_update')

export const notifyBalanceUpdate = (walletAddress: string) =>
    notifyTradingUpdate(walletAddress, 'balance_update')