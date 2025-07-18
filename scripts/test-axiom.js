const fetch = require('node-fetch')

async function testAxiomAPI() {
  console.log('🧪 Testing Axiom API integration...')
  
  try {
    // Test with the example pair address from the user query
    const pairAddress = '9MTTqM6r7MKM9CGi2DzxR7yA4RhunNn2xeAFn3mDZ6Tm'
    
    console.log(`📡 Fetching data for pair: ${pairAddress}`)
    
    const response = await fetch(`http://localhost:3000/api/axiom/token-info?pairAddress=${pairAddress}`)
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const data = await response.json()
    
    console.log('✅ Axiom API test successful!')
    console.log('📊 Response data:')
    console.log(JSON.stringify(data, null, 2))
    
    // Validate the response structure
    if (data.success && data.data) {
      const requiredFields = ['numHolders', 'insidersHoldPercent', 'bundlersHoldPercent', 'totalPairFeesPaid']
      const missingFields = requiredFields.filter(field => !(field in data.data))
      
      if (missingFields.length === 0) {
        console.log('✅ All required fields present')
        console.log(`📈 Risk indicators:`)
        console.log(`   - Insiders: ${data.data.insidersHoldPercent.toFixed(1)}%`)
        console.log(`   - Bundlers: ${data.data.bundlersHoldPercent.toFixed(1)}%`)
        console.log(`   - Total Fees: $${data.data.totalPairFeesPaid.toFixed(0)}`)
        console.log(`   - Holders: ${data.data.numHolders.toLocaleString()}`)
      } else {
        console.log('❌ Missing required fields:', missingFields)
      }
    } else {
      console.log('❌ Invalid response structure')
    }
    
  } catch (error) {
    console.error('❌ Axiom API test failed:', error.message)
    
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 Make sure the development server is running: npm run dev')
    }
  }
}

// Run the test
testAxiomAPI() 