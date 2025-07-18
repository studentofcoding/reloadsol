const fetch = require('node-fetch')

async function testGraduatedPoolFlow() {
  console.log('🧪 Testing graduated pool flow...')
  
  try {
    // Test with a known token that should have a graduated pool
    const mintAddress = 'CN8V1z4TNsQ3FfkcyQe4UcJUG1YZUCGsPDrCheF3bonk'
    
    console.log(`📡 Testing graduated pool flow for mint: ${mintAddress}`)
    console.log(`📡 Flow: mint -> Jupiter metadata -> graduated pool -> Axiom`)
    
    // Step 1: Test Jupiter metadata endpoint
    console.log('\n🔍 Step 1: Testing Jupiter metadata endpoint...')
    const jupiterResponse = await fetch(`http://localhost:3000/api/jupiter/metadata?mint=${mintAddress}`)
    
    if (!jupiterResponse.ok) {
      throw new Error(`Jupiter metadata failed: ${jupiterResponse.status}`)
    }
    
    const jupiterData = await jupiterResponse.json()
    console.log('✅ Jupiter metadata response:', JSON.stringify(jupiterData, null, 2))
    
    const graduatedPool = jupiterData.data?.graduatedPool
    if (!graduatedPool) {
      console.log('⚠️  No graduated pool found in Jupiter metadata')
      console.log('📊 This is expected for some tokens that don\'t have graduated pools')
    } else {
      console.log(`✅ Found graduated pool: ${graduatedPool}`)
    }
    
    // Step 2: Test the complete Axiom flow
    console.log('\n🔍 Step 2: Testing complete Axiom flow...')
    const axiomResponse = await fetch(`http://localhost:3000/api/axiom/token-info?pairAddress=${mintAddress}`)
    
    console.log(`📊 Axiom response status: ${axiomResponse.status}`)
    
    const axiomData = await axiomResponse.json()
    console.log('📊 Axiom response data:')
    console.log(JSON.stringify(axiomData, null, 2))
    
    // Analyze the response
    if (axiomResponse.status === 404 && axiomData.pairNotFound) {
      if (axiomData.error?.includes('No graduated pool available')) {
        console.log('✅ Correctly handled: Token has no graduated pool')
      } else if (axiomData.error?.includes('Token not found in Axiom database')) {
        console.log('✅ Correctly handled: Token has graduated pool but not in Axiom database')
      } else {
        console.log('✅ Correctly handled: Pair not found error')
      }
    } else if (axiomResponse.status === 200 && axiomData.success) {
      console.log('✅ Successfully fetched Axiom data using graduated pool')
      console.log(`📊 Risk data available for token with graduated pool`)
    } else {
      console.log('❌ Unexpected response')
      console.log(`Status: ${axiomResponse.status}`)
      console.log(`Error: ${axiomData.error}`)
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message)
    
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 Make sure the development server is running: npm run dev')
    }
  }
}

// Run the test
testGraduatedPoolFlow() 