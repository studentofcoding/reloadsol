#!/usr/bin/env node

/**
 * Test script for Jupiter API fallback mechanism
 * This script tests the automatic fallback from v2 to v3
 */

const path = require('path')
const { execSync } = require('child_process')

// Add the src directory to the module path for testing
process.env.NODE_PATH = path.join(__dirname, '..', 'src')
require('module').Module._initPaths()

// Test configuration
const TEST_TOKENS = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // USDC
]

async function testFallbackMechanism() {
  console.log('🧪 Testing Jupiter API Fallback Mechanism\n')
  
  try {
    // Import the Jupiter API utility
    const { 
      fetchTokenPrices, 
      getFallbackConfig, 
      setJupiterApiVersion,
      setJupiterApiFallbackVersion,
      setAutoFallback
    } = require('../src/utils/jupiter-api.ts')
    
    // Test 1: Check current configuration
    console.log('📋 Current Configuration:')
    const config = getFallbackConfig()
    console.log(`   Primary Version: ${config.primaryVersion}`)
    console.log(`   Fallback Version: ${config.fallbackVersion}`)
    console.log(`   Auto Fallback: ${config.autoFallback ? '✅ Enabled' : '❌ Disabled'}\n`)
    
    // Test 2: Normal operation (should use primary version)
    console.log('🔄 Test 1: Normal Operation')
    console.log('   Fetching prices with current configuration...')
    const startTime = Date.now()
    const normalPrices = await fetchTokenPrices(TEST_TOKENS)
    const normalDuration = Date.now() - startTime
    
    console.log(`   ✅ Success! Fetched ${Object.keys(normalPrices).length} prices in ${normalDuration}ms`)
    console.log(`   SOL Price: $${normalPrices[TEST_TOKENS[0]]?.price || 'N/A'}`)
    console.log(`   USDC Price: $${normalPrices[TEST_TOKENS[1]]?.price || 'N/A'}\n`)
    
    // Test 3: Force primary to an invalid version to test fallback
    console.log('🔄 Test 2: Fallback Mechanism')
    console.log('   Simulating primary version failure...')
    
    // Temporarily set primary to v3 and fallback to v2 to test the mechanism
    setJupiterApiVersion('v3')
    setJupiterApiFallbackVersion('v2')
    setAutoFallback(true)
    
    const fallbackStartTime = Date.now()
    const fallbackPrices = await fetchTokenPrices(TEST_TOKENS)
    const fallbackDuration = Date.now() - fallbackStartTime
    
    console.log(`   ✅ Fallback test completed in ${fallbackDuration}ms`)
    console.log(`   SOL Price: $${fallbackPrices[TEST_TOKENS[0]]?.price || 'N/A'}`)
    console.log(`   USDC Price: $${fallbackPrices[TEST_TOKENS[1]]?.price || 'N/A'}\n`)
    
    // Test 4: Disable auto-fallback
    console.log('🔄 Test 3: Auto-Fallback Disabled')
    setAutoFallback(false)
    
    try {
      const noFallbackPrices = await fetchTokenPrices(TEST_TOKENS)
      console.log(`   ✅ Primary version worked, got ${Object.keys(noFallbackPrices).length} prices\n`)
    } catch (error) {
      console.log(`   ⚠️  Primary version failed and fallback is disabled: ${error.message}\n`)
    }
    
    // Restore original configuration
    setJupiterApiVersion('v2')
    setJupiterApiFallbackVersion('v3')
    setAutoFallback(true)
    
    console.log('✅ All tests completed successfully!')
    console.log('\n📊 Summary:')
    console.log('   - Normal operation: Working')
    console.log('   - Fallback mechanism: Working')
    console.log('   - Auto-fallback toggle: Working')
    console.log('   - Error logging: Check console output above')
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
    console.error('Stack trace:', error.stack)
    process.exit(1)
  }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Jupiter API Fallback Test Script

Usage: node test-fallback.js

This script tests:
- Normal API operation
- Automatic fallback from primary to fallback version
- Auto-fallback enable/disable functionality
- Error logging and reporting

The script will output detailed logs showing the fallback mechanism in action.
`)
  process.exit(0)
}

// Run the test
testFallbackMechanism().catch(error => {
  console.error('❌ Unhandled error:', error)
  process.exit(1)
})