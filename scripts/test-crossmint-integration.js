const axios = require('axios');

async function testCrossmintIntegration() {
  const baseUrl = 'http://localhost:3000';
  
  try {
    console.log('🧪 Testing Crossmint embedded wallet integration...');
    console.log('📍 Base URL:', baseUrl);
    console.log('🔧 Environment: staging (as configured in .env.local)');
    
    // Test wallet creation with email
    console.log('\n1️⃣ Testing wallet creation with email...');
    const createResponse = await axios.post(`${baseUrl}/api/embedded-wallet/create`, {
      email: 'test@example.com'
    });
    
    console.log('✅ Wallet creation response:', JSON.stringify(createResponse.data, null, 2));
    
    if (createResponse.data.success && createResponse.data.wallet) {
      const userIdentifier = 'test@example.com';
      
      // Test wallet retrieval
      console.log('\n2️⃣ Testing wallet retrieval...');
      const getResponse = await axios.get(`${baseUrl}/api/embedded-wallet/${encodeURIComponent(userIdentifier)}`);
      console.log('✅ Wallet retrieval response:', JSON.stringify(getResponse.data, null, 2));
    }
    
    // Test wallet creation with userId
    console.log('\n3️⃣ Testing wallet creation with userId...');
    const createResponse2 = await axios.post(`${baseUrl}/api/embedded-wallet/create`, {
      userId: 'test-user-456'
    });
    
    console.log('✅ Wallet creation with userId response:', JSON.stringify(createResponse2.data, null, 2));
    
    console.log('\n🎉 All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      url: error.config?.url
    });
    
    // Additional debugging for staging environment
    if (error.response?.status === 500) {
      console.log('\n🔍 Debugging info:');
      console.log('- Make sure your Next.js server is running (npm run dev)');
      console.log('- Check that CROSSMINT_API_KEY starts with "sk_staging_"');
      console.log('- Verify CROSSMINT_ENVIRONMENT=staging in .env.local');
      console.log('- Ensure the staging endpoint is accessible');
    }
  }
}

// Add some delay to ensure server is ready
setTimeout(testCrossmintIntegration, 1000);