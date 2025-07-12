#!/usr/bin/env node

/**
 * Script to check current trading mode and toggle between simulation and real trading
 * Usage:
 *   node scripts/toggle-trading-mode.js check
 *   node scripts/toggle-trading-mode.js enable
 *   node scripts/toggle-trading-mode.js disable
 */

const SECRET_KEY = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
const API_HOST = process.env.API_HOST || 'https://v2.reloadsol.xyz'

async function checkTradingMode() {
  try {
    console.log('🔍 Checking current trading mode...')
    
    const response = await fetch(`${API_HOST}/api/trending/track?token=check`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    
    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`)
    }
    
    const data = await response.json()
    
    // This will return an error for invalid token, but we can check for trading mode info
    console.log('ℹ️  To check active trading modes, you need to query the database directly or check Discord notifications')
    console.log('💡 Use "enable" or "disable" commands to change trading mode')
    
  } catch (error) {
    console.error('❌ Error checking trading mode:', error.message)
  }
}

async function setTradingMode(isSimulated) {
  try {
    const mode = isSimulated ? 'simulation' : 'real trading'
    console.log(`🔄 Setting trading mode to: ${mode}`)
    
    const response = await fetch(`${API_HOST}/api/trending/track?key=${SECRET_KEY}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        isSimulated: isSimulated
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API responded with status: ${response.status}\n${errorText}`)
    }
    
    const result = await response.json()
    console.log('✅ Trading mode updated successfully!')
    console.log(`📊 Current mode: ${result.mode}`)
    console.log(`💬 Message: ${result.message}`)
    
    if (!isSimulated) {
      console.log('\n🔥 REAL TRADING ENABLED!')
      console.log('⚠️  Make sure you have:')
      console.log('   - TRADING_KEYPAIR_JSON environment variable set')
      console.log('   - DISCORD_WEBHOOK_AUTO_TRADE environment variable set')
      console.log('   - Sufficient SOL balance in your trading wallet')
      console.log('   - Reviewed the safety limits (MAX_SOL_AT_RISK, MIN_SOL_BALANCE)')
    } else {
      console.log('\n💻 Simulation mode enabled - no real trades will be executed')
    }
    
  } catch (error) {
    console.error('❌ Error setting trading mode:', error.message)
    
    if (error.message.includes('401')) {
      console.error('🔐 Make sure TRENDING_TRACKER_SECRET environment variable is set correctly')
    }
    
    if (error.message.includes('Trading keypair not configured')) {
      console.error('🔑 For real trading, you need to set TRADING_KEYPAIR_JSON environment variable')
      console.error('   Export your wallet private key as a JSON array: [123,45,67,89,...]')
    }
  }
}

// Main execution
const command = process.argv[2]

switch (command) {
  case 'check':
    checkTradingMode()
    break
    
  case 'enable':
  case 'real':
  case 'live':
    setTradingMode(false) // Real trading
    break
    
  case 'disable':
  case 'sim':
  case 'simulation':
    setTradingMode(true) // Simulation
    break
    
  default:
    console.log('🚀 Trading Mode Toggle Script')
    console.log('')
    console.log('Usage:')
    console.log('  node scripts/toggle-trading-mode.js check      # Check current mode')
    console.log('  node scripts/toggle-trading-mode.js enable     # Enable real trading')
    console.log('  node scripts/toggle-trading-mode.js disable    # Enable simulation mode')
    console.log('')
    console.log('Environment variables needed:')
    console.log('  TRENDING_TRACKER_SECRET     # API secret key')
    console.log('  TRADING_KEYPAIR_JSON        # Wallet private key (for real trading)')
    console.log('  DISCORD_WEBHOOK_AUTO_TRADE  # Discord webhook URL')
    console.log('  API_HOST                    # API base URL (default: http://localhost:3000)')
    process.exit(1)
} 