#!/usr/bin/env node

// Simple script to manually trigger PnL updates
// Usage: node scripts/update-pnl.js

const SITE_URL = process.env.SITE_URL || 'http://localhost:3000'
const PNL_TOKEN = process.env.PNL_UPDATE_TOKEN || 'simple-pnl-token'

async function updatePnL() {
  try {
    console.log('🔄 Triggering PnL update...')
    
    const response = await fetch(`${SITE_URL}/api/pnl/update`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PNL_TOKEN}`,
        'Content-Type': 'application/json'
      }
    })
    
    const result = await response.json()
    
    if (response.ok) {
      console.log('✅ PnL update successful!')
      console.log('📊 Results:', result.message)
      console.log('🕐 Timestamp:', result.timestamp)
      
      if (result.results && result.results.length > 0) {
        console.log('📈 Sample results:')
        result.results.forEach((r, i) => {
          console.log(`  ${i + 1}. ${r.wallet_address.slice(0, 8)}... - PnL: $${r.total_pnl_usd.toFixed(2)} (${r.total_trades} trades)`)
        })
      }
    } else {
      console.error('❌ PnL update failed:', result.error)
      console.error('💬 Message:', result.message)
    }
    
  } catch (error) {
    console.error('🚨 Error triggering PnL update:', error.message)
  }
}

// Run the update
updatePnL() 