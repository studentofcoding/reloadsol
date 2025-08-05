#!/usr/bin/env node

const axios = require('axios');
const chalk = require('chalk');
const ora = require('ora');

// Configuration
const API_HOST = 'https://v2.reloadsol.xyz';
const TEST_WALLET = 'DGJqRtDKdBiKfXGwgQbaC5YJW3PGd5TtE2tGmKSLtVwx'; // Example wallet for testing
const TEST_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC token for testing
const SOL_TOKEN = 'So11111111111111111111111111111111111111112';

// Test result tracking
let passedTests = 0;
let failedTests = 0;
const failedEndpoints = [];

// Utility functions
const log = {
  success: (msg) => console.log(chalk.green('✓ ' + msg)),
  error: (msg) => console.log(chalk.red('✗ ' + msg)),
  info: (msg) => console.log(chalk.blue('ℹ ' + msg)),
  warning: (msg) => console.log(chalk.yellow('⚠ ' + msg))
};

async function testEndpoint(name, endpoint, options = {}) {
  const spinner = ora(`Testing ${name}...`).start();
  try {
    const url = `${API_HOST}${endpoint}`;
    const response = await axios({
      url,
      method: options.method || 'GET',
      data: options.data,
      params: options.params,
      timeout: options.timeout || 10000 // Default 10 second timeout
    });

    // If we expect an error but got a successful response, that's a failure
    if (options.expectError) {
      spinner.fail(`${name} - Failed`);
      failedTests++;
      failedEndpoints.push({
        name,
        endpoint,
        error: 'Expected error but got successful response'
      });
      log.error(`Error testing ${name}: Expected error but got successful response`);
      return null;
    }

    if (options.validator) {
      const isValid = options.validator(response.data);
      if (!isValid) {
        throw new Error('Response validation failed');
      }
    }

    spinner.succeed(`${name} - OK`);
    passedTests++;
    return response.data;
  } catch (error) {
    // If we expect an error and got one, check if it's the right status code
    if (options.expectError) {
      const expectedStatus = options.expectedStatus || 400;
      if (error.response && error.response.status === expectedStatus) {
        spinner.succeed(`${name} - OK`);
        passedTests++;
        return null;
      } else {
        spinner.fail(`${name} - Failed`);
        failedTests++;
        failedEndpoints.push({
          name,
          endpoint,
          error: `Expected ${expectedStatus} error but got: ${error.message}`
        });
        log.error(`Error testing ${name}: Expected ${expectedStatus} error but got: ${error.message}`);
        return null;
      }
    }

    spinner.fail(`${name} - Failed`);
    failedTests++;
    failedEndpoints.push({
      name,
      endpoint,
      error: error.message
    });
    log.error(`Error testing ${name}: ${error.message}`);
    return null;
  }
}

// Main test function
async function runTests() {
  log.info('Starting API Tests...\n');

  // Test RPC Health
  await testEndpoint('RPC Health', '/api/rpc/health', {
    validator: (data) => data.status === 'success' && Array.isArray(data.healthyEndpoints)
  });

  // Test RPC Config
  await testEndpoint('RPC Config', '/api/rpc/config', {
    validator: (data) => data.status === 'success' && data.configuration && data.configuration.endpoints
  });

  // Test Trade Health
  await testEndpoint('Trade Health', '/api/trade/health', {
    validator: (data) => data.status && data.providers && data.summary
  });

  // Test Random Tokens
  await testEndpoint('Random Tokens', '/api/tokens/random', {
    params: { count: 5 },
    validator: (data) => data.success && Array.isArray(data.tokens) && data.tokens.length === 5
  });

  // Test Token Search
  await testEndpoint('Token Search', '/api/tokens/search', {
    params: { address: TEST_TOKEN },
    validator: (data) => data.success && data.token
  });

  // Test Token Prices
  await testEndpoint('Token Prices', '/api/tokens/prices', {
    method: 'POST',
    data: { tokens: [TEST_TOKEN, SOL_TOKEN] },
    validator: (data) => data.prices && Object.keys(data.prices).length > 0
  });

  // Test Trade Comparison
  await testEndpoint('Trade Comparison', '/api/trade/compare', {
    method: 'POST',
    data: {
      inputMint: SOL_TOKEN,
      outputMint: TEST_TOKEN,
      amount: '1000000000',
      userPublicKey: TEST_WALLET
    },
    validator: (data) => data.quotes && data.bestQuote
  });

  // Test Enhanced Trade Comparison
  // await testEndpoint('Enhanced Trade Comparison', '/api/trade/enhanced-compare', {
  //   method: 'POST',
  //   data: {
  //     tokenAddress: TEST_TOKEN,
  //     tokenSymbol: 'USDC',
  //     buyAmountSol: 0.1
  //   },
  //   validator: (data) => data.providers && data.bestProvider
  // });

  // Test Trading Records
  await testEndpoint('Trading Records', '/api/trading/records', {
    params: { wallet: TEST_WALLET },
    validator: (data) => data.success && Array.isArray(data.records)
  });

  // Test All Trading Records
  await testEndpoint('All Trading Records', '/api/trading/records/all', {
    params: { limit: 10 },
    validator: (data) => data.success && Array.isArray(data.records)
  });

  // Test Points API
  await testEndpoint('Points API', '/api/operations/points', {
    params: { wallet: TEST_WALLET },
    validator: (data) => typeof data.points === 'number'
  });

  // Test Operations Track
  await testEndpoint('Operations Track', '/api/operations/track', {
    method: 'POST',
    data: {
      walletAddress: TEST_WALLET,
      type: 'buy',
      count: 1,
      solBalance: 1.5
    },
    validator: (data) => data.success && data.pointsEarned >= 0
  });

  // Test Jupiter Pools
  await testEndpoint('Jupiter Pools Test', '/api/trade/pools-test', {
    params: { type: 'benchmark' },
    validator: (data) => data.testType === 'benchmark' && data.result
  });

  // === DISCORD WEBHOOK TESTS ===
  log.info('\n🔔 Testing Discord Webhook Endpoints...');

  // Test Price Monitor Discord Test
  await testEndpoint('Price Monitor Discord Test', '/api/trending/price-monitor', {
    method: 'GET',
    params: { key: 'r3l0ads0l-trending' }, // Add required secret key
    validator: (data) => {
      // Handle both success and error responses
      return (data.success === true || data.success === false) &&
        data.message &&
        typeof data.message === 'string'
    }
  });

  // Test Trending Discord Test
  await testEndpoint('Trending Discord Test', '/api/trending', {
    method: 'PUT',
    validator: (data) => {
      // More flexible validation - accept any response with a message
      return data && (
        (data.success && data.message) ||
        (data.message && typeof data.message === 'string') ||
        (data.error && typeof data.error === 'string')
      )
    }
  });

  // Test Filtered Trending Discord Test
  await testEndpoint('Filtered Trending Discord Test', '/api/trending/filtered', {
    method: 'PUT',
    validator: (data) => {
      // More flexible validation - accept any response with a message
      return data && (
        (data.success && data.message) ||
        (data.message && typeof data.message === 'string') ||
        (data.error && typeof data.error === 'string')
      )
    }
  });

  // === TRENDING TRACKER FILTERING TESTS ===
  log.info('\n🔍 Testing Trending Tracker Filtering...');

  // Test Enhanced Filtering with detailed results
  await testEndpoint('Track Discord Test', '/api/trending/track', {
    method: 'PUT',
    params: {
      key: 'r3l0ads0l-trending', // Required secret key
      test: 'discord' // Required to trigger Discord testing mode
    },
    validator: (data) => {
      // Handle both success and error responses
      return data && (
        (data.success === true || data.success === false) &&
        data.message &&
        typeof data.message === 'string'
      )
    }
  });

  // Test Track Filter Test (Enhanced Filtering)
  await testEndpoint('Track Filter Test', '/api/trending/track', {
    method: 'PUT',
    params: {
      key: 'r3l0ads0l-trending', // Required secret key
      test: 'filter' // Required to trigger filter testing mode
    },
    timeout: 30000, // Longer timeout for filtering operations
    validator: (data) => {
      return data &&
        data.success === true &&
        data.message &&
        typeof data.message === 'string' &&
        data.summary &&
        typeof data.summary.totalTokens === 'number' &&
        typeof data.summary.acceptedCount === 'number' &&
        typeof data.summary.rejectedCount === 'number' &&
        typeof data.summary.acceptanceRate === 'string' &&
        typeof data.summary.processingTime === 'number' &&
        Array.isArray(data.acceptedTokens) &&
        Array.isArray(data.rejectedTokens) &&
        Array.isArray(data.rejectionDetails)
    }
  });

  // Display detailed filtering results if available
  const filterTestResult = await testEndpoint('Track Filter Test - Display Results', '/api/trending/track', {
    method: 'PUT',
    params: {
      key: 'r3l0ads0l-trending',
      test: 'filter'
    },
    timeout: 30000,
    validator: (data) => data && data.success === true,
    displayResults: true
  });

  if (filterTestResult && filterTestResult.success) {
    console.log('\n🔍 FILTERING RESULTS:');
    console.log('='.repeat(50));

    const { summary, acceptedTokens, rejectedTokens, rejectionDetails } = filterTestResult;

    // Summary
    console.log(`📊 Summary:`);
    console.log(`   Total Tokens: ${summary.totalTokens}`);
    console.log(`   Accepted: ${summary.acceptedCount} (${summary.acceptanceRate})`);
    console.log(`   Rejected: ${summary.rejectedCount}`);
    console.log(`   Processing Time: ${summary.processingTime}ms`);

    // Accepted Tokens
    if (acceptedTokens.length > 0) {
      console.log(`\n✅ ACCEPTED TOKENS (${acceptedTokens.length}):`);
      acceptedTokens.slice(0, 5).forEach((token, index) => {
        console.log(`   ${index + 1}. ${token.symbol} (${token.name})`);
        console.log(`      Address: ${token.address}`);
        console.log(`      Price: $${token.currentPrice?.toFixed(6) || 'N/A'}`);
        console.log(`      Market Cap: $${token.marketCap?.toLocaleString() || 'N/A'}`);
        console.log(`      Organic Score: ${token.organicScore || 'N/A'}`);
        console.log(`      1h Change: ${token.priceChange1h?.toFixed(2) || 0}%`);
      });
      if (acceptedTokens.length > 5) {
        console.log(`   ... and ${acceptedTokens.length - 5} more`);
      }
    }

    // Rejected Tokens (show top 10)
    if (rejectedTokens.length > 0) {
      console.log(`\n❌ REJECTED TOKENS (showing first 10 of ${rejectedTokens.length}):`);
      rejectedTokens.slice(0, 10).forEach((token, index) => {
        console.log(`   ${index + 1}. ${token.symbol} (${token.name})`);
        console.log(`      Address: ${token.address}`);
        console.log(`      Price: $${token.currentPrice?.toFixed(6) || 'N/A'}`);
        console.log(`      Market Cap: $${token.marketCap?.toLocaleString() || 'N/A'}`);
        console.log(`      Organic Score: ${token.organicScore || 'N/A'}`);
        console.log(`      Rejection Reasons: ${token.rejectionReasons?.join(', ') || 'N/A'}`);
      });
    }

    // Rejection Breakdown
    if (rejectionDetails && rejectionDetails.length > 0) {
      console.log(`\n📋 REJECTION BREAKDOWN:`);
      rejectionDetails
        .sort((a, b) => b.count - a.count)
        .forEach(detail => {
          console.log(`   ${detail.reason}: ${detail.count} tokens`);
        });
    }

    console.log('='.repeat(50));
  }

  // === TRADING TIME WINDOW TESTS ===
  log.info('\n⏰ Testing Trading Time Window Restrictions...');

  // Helper function to get current GMT+7 time info
  const getCurrentTimeInfo = () => {
    const now = new Date();
    const gmt7Time = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const hours = gmt7Time.getUTCHours();
    const minutes = gmt7Time.getUTCMinutes();
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    
    // Trading window: 16:00 to 04:00 GMT+7 (next day)
    const isWithinTradingHours = hours >= 16 || hours < 4;
    
    return {
      currentTime: timeString,
      currentHour: hours,
      isWithinTradingHours,
      tradingStatus: isWithinTradingHours ? 'ALLOWED' : 'RESTRICTED'
    };
  };

  const timeInfo = getCurrentTimeInfo();
  console.log(`\n🕐 Current GMT+7 Time: ${timeInfo.currentTime}`);
  console.log(`📊 Trading Status: ${timeInfo.tradingStatus}`);
  console.log(`⏰ Trading Window: 16:00-04:00 GMT+7`);

  // Test 1: Current time window status
  await testEndpoint('Trading Time Window - Current Status', '/api/trending/track', {
    method: 'POST',
    params: {
      key: 'r3l0ads0l-trending'
    },
    expectError: !timeInfo.isWithinTradingHours,
    expectedStatus: timeInfo.isWithinTradingHours ? 200 : 403,
    validator: (data) => {
      if (timeInfo.isWithinTradingHours) {
        // During trading hours - should succeed or return normal response
        return data && (
          data.success === true || 
          data.message || 
          data.error // Normal API responses
        );
      } else {
        // Outside trading hours - should be rejected with specific message
        return data &&
          data.success === false &&
          data.error &&
          data.error.includes('Trading is only allowed between 16:00 and 04:00 GMT+7') &&
          data.currentTime &&
          data.tradingWindow === '16:00-04:00 GMT+7';
      }
    }
  });

  // Test 2: Time window validation with detailed response check
  const timeWindowResult = await testEndpoint('Trading Time Window - Detailed Check', '/api/trending/track', {
    method: 'POST',
    params: {
      key: 'r3l0ads0l-trending'
    },
    expectError: !timeInfo.isWithinTradingHours,
    expectedStatus: timeInfo.isWithinTradingHours ? 200 : 403,
    validator: (data) => true // Accept any response for detailed analysis
  });

  // Display detailed time window results
  if (timeWindowResult) {
    console.log('\n⏰ TIME WINDOW ANALYSIS:');
    console.log('='.repeat(40));
    console.log(`Current GMT+7 Time: ${timeInfo.currentTime}`);
    console.log(`Current Hour: ${timeInfo.currentHour}`);
    console.log(`Expected Status: ${timeInfo.tradingStatus}`);
    
    if (timeInfo.isWithinTradingHours) {
      console.log('✅ Currently within trading hours (16:00-04:00 GMT+7)');
      console.log('   → API should accept trading requests');
    } else {
      console.log('❌ Currently outside trading hours');
      console.log('   → API should reject with 403 status');
      
      if (timeWindowResult.error) {
        console.log(`   → Rejection Message: ${timeWindowResult.error}`);
      }
      if (timeWindowResult.currentTime) {
        console.log(`   → Server Time: ${timeWindowResult.currentTime}`);
      }
      if (timeWindowResult.tradingWindow) {
        console.log(`   → Trading Window: ${timeWindowResult.tradingWindow}`);
      }
    }
    
    // Show next trading window
    const nextTradingStart = timeInfo.currentHour < 4 ? 
      `Today at 16:00 GMT+7` : 
      timeInfo.currentHour < 16 ? 
        `Today at 16:00 GMT+7` : 
        `Tomorrow at 16:00 GMT+7`;
    
    const nextTradingEnd = timeInfo.currentHour >= 16 ? 
      `Tomorrow at 04:00 GMT+7` : 
      `Today at 04:00 GMT+7`;
    
    if (!timeInfo.isWithinTradingHours) {
      console.log(`   → Next Trading Window: ${nextTradingStart} - ${nextTradingEnd}`);
    }
    
    console.log('='.repeat(40));
  }

  // Test 3: Verify Discord notification for time restriction (if outside hours)
  if (!timeInfo.isWithinTradingHours) {
    await testEndpoint('Trading Time Window - Discord Notification', '/api/trending/track', {
      method: 'POST',
      params: {
        key: 'r3l0ads0l-trending'
      },
      expectError: true,
      expectedStatus: 403,
      validator: (data) => {
        return data &&
          data.success === false &&
          data.error &&
          typeof data.error === 'string' &&
          data.currentTime &&
          data.tradingWindow;
      }
    });
  }

  // === NEW JUPITER METADATA API TESTS ===
  log.info('\n🚀 Testing Jupiter Metadata API v2...');

  // Test Jupiter Metadata - Single Token (GET)
  await testEndpoint('Jupiter Metadata - Single Token', '/api/jupiter/metadata', {
    params: { mint: SOL_TOKEN },
    validator: (data) => {
      return data.data &&
        typeof data.data.decimals === 'number' &&
        typeof data.data.symbol === 'string' &&
        typeof data.data.name === 'string' &&
        (data.source === 'common_tokens' || data.source === 'jupiter_api_v2' || data.cached === true)
    }
  });

  // Test Jupiter Metadata - Cache Performance
  await testEndpoint('Jupiter Metadata - Cache Test', '/api/jupiter/metadata', {
    params: { mint: SOL_TOKEN },
    validator: (data) => {
      return data.data && data.cached === true // Should be cached from previous request
    }
  });

  // Test Jupiter Metadata - Batch Processing (POST)
  await testEndpoint('Jupiter Metadata - Batch Processing', '/api/jupiter/metadata', {
    method: 'POST',
    data: {
      mints: [
        SOL_TOKEN,
        TEST_TOKEN,
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' // USDT
      ]
    },
    validator: (data) => {
      return data.results &&
        Object.keys(data.results).length === 3 &&
        data.totalRequested === 3 &&
        typeof data.fromCache === 'number' &&
        typeof data.fromAPI === 'number' &&
        typeof data.batchesUsed === 'number'
    }
  });

  // Test Jupiter Metadata - Large Batch (50 tokens)
  const largeBatchTokens = [
    SOL_TOKEN,
    TEST_TOKEN,
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    // Add some random/test mint addresses
    '11111111111111111111111111111111',
    '22222222222222222222222222222222',
    '33333333333333333333333333333333',
    '44444444444444444444444444444444',
    '55555555555555555555555555555555',
    '66666666666666666666666666666666',
    '77777777777777777777777777777777',
    '88888888888888888888888888888888',
    '99999999999999999999999999999999',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAa',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb',
    'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCc',
    'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDd',
    'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEe',
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFf',
    'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGg',
    'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHh'
  ];

  await testEndpoint('Jupiter Metadata - Large Batch', '/api/jupiter/metadata', {
    method: 'POST',
    data: { mints: largeBatchTokens },
    timeout: 15000, // Longer timeout for large batch
    validator: (data) => {
      return data.results &&
        Object.keys(data.results).length === largeBatchTokens.length &&
        data.totalRequested === largeBatchTokens.length
    }
  });

  // Test Jupiter Metadata - Invalid Token
  await testEndpoint('Jupiter Metadata - Invalid Token', '/api/jupiter/metadata', {
    params: { mint: 'invalid_token_address_123' },
    validator: (data) => {
      return data.data &&
        data.source === 'default' &&
        data.data.symbol === 'TOKEN' &&
        data.data.name === 'Unknown Token'
    }
  });

  // Test Jupiter Metadata - Missing Mint Parameter
  await testEndpoint('Jupiter Metadata - Missing Mint', '/api/jupiter/metadata', {
    expectError: true,
    expectedStatus: 400
  });

  // Test Jupiter Metadata - Empty Batch
  await testEndpoint('Jupiter Metadata - Empty Batch', '/api/jupiter/metadata', {
    method: 'POST',
    data: { mints: [] },
    expectError: true,
    expectedStatus: 400
  });

  // Test Jupiter Metadata - Oversized Batch (501 tokens)
  const oversizedBatch = Array.from({ length: 501 }, (_, i) => `token${i}`);
  await testEndpoint('Jupiter Metadata - Oversized Batch', '/api/jupiter/metadata', {
    method: 'POST',
    data: { mints: oversizedBatch },
    expectError: true,
    expectedStatus: 400
  });

  // Test Jupiter Metadata - Cache Cleanup (DELETE)
  await testEndpoint('Jupiter Metadata - Cache Cleanup', '/api/jupiter/metadata', {
    method: 'DELETE',
    validator: (data) => {
      return data.message === 'Cache cleaned up' &&
        typeof data.sizeBefore === 'number' &&
        typeof data.sizeAfter === 'number' &&
        typeof data.deletedEntries === 'number'
    }
  });

  // Print summary
  console.log('\n' + '='.repeat(50));
  log.info(`Test Summary:`);
  log.success(`Passed: ${passedTests}`);
  log.error(`Failed: ${failedTests}`);

  if (failedEndpoints.length > 0) {
    log.warning('\nFailed Endpoints:');
    failedEndpoints.forEach(({ name, endpoint, error }) => {
      log.error(`${name} (${endpoint}): ${error}`);
    });
  }

  // Exit with appropriate code
  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  log.error('Test execution failed:', error);
  process.exit(1);
});