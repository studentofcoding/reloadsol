const fetch = require('node-fetch')

async function testAxiomErrorHandling() {
  console.log('🧪 Testing Axiom error handling with graduated pool flow...')
  
  try {
    // Test with a token that doesn't exist in Axiom database
    const mintAddress = 'CN8V1z4TNsQ3FfkcyQe4UcJUG1YZUCGsPDrCheF3bonk'
    
    console.log(`📡 Testing error handling for mint: ${mintAddress}`)
    console.log(`📡 This will first get graduated pool from Jupiter, then query Axiom`)
    
    // Test the new flow: mint -> graduated pool -> axiom
    const response = await fetch(`http://localhost:3000/api/axiom/token-info?pairAddress=${mintAddress}`)
    
    console.log(`📊 Response status: ${response.status}`)
    
    const data = await response.json()
    
    console.log('📊 Response data:')
    console.log(JSON.stringify(data, null, 2))
    
    // Check if the error is handled correctly
    if (response.status === 404 && data.pairNotFound) {
      console.log('✅ Error handling working correctly!')
      console.log('✅ "Pair not found" error properly handled')
      console.log('✅ UI will show "No Data" instead of error')
    } else {
      console.log('❌ Error handling not working as expected')
      console.log(`Expected: status 404 with pairNotFound: true`)
      console.log(`Got: status ${response.status} with pairNotFound: ${data.pairNotFound}`)
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
    
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 Make sure the development server is running: npm run dev')
    }
  }
}

// Run the test
testAxiomErrorHandling() 