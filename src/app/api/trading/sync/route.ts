import { NextRequest, NextResponse } from 'next/server'

// Simple in-memory store for sync notifications
const syncNotifications = new Map<string, { timestamp: number; source: string }>()

export async function POST(request: NextRequest) {
    try {
        const { walletAddress, timestamp, source } = await request.json()

        if (!walletAddress) {
            return NextResponse.json({ error: 'Wallet address required' }, { status: 400 })
        }

        // Store sync notification
        syncNotifications.set(walletAddress, { timestamp, source })

        // Clean up old notifications (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
        for (const [key, value] of Array.from(syncNotifications.entries())) {
            if (value.timestamp < fiveMinutesAgo) {
                syncNotifications.delete(key)
            }
        }

        console.log(`📡 Sync notification received for ${walletAddress.slice(0, 8)}... from ${source}`)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Sync notification error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const walletAddress = searchParams.get('wallet')

        if (!walletAddress) {
            return NextResponse.json({ error: 'Wallet address required' }, { status: 400 })
        }

        const notification = syncNotifications.get(walletAddress)
        const hasUpdate = notification && (Date.now() - notification.timestamp) < 30000 // 30 seconds

        return NextResponse.json({
            hasUpdate: !!hasUpdate,
            lastUpdate: notification?.timestamp || null,
            source: notification?.source || null
        })
    } catch (error) {
        console.error('Sync check error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}