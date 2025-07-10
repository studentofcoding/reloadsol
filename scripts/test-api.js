#!/usr/bin/env node

const axios = require('axios');
const chalk = require('chalk');
const ora = require('ora');

// Configuration
const BASE_URL = 'https://test.reloadsol.xyz';
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
    const url = `${BASE_URL}${endpoint}`;
    const response = await axios({
      url,
      method: options.method || 'GET',
      data: options.data,
      params: options.params,
      timeout: 10000 // 10 second timeout
    });

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
  await testEndpoint('Enhanced Trade Comparison', '/api/trade/enhanced-compare', {
    method: 'POST',
    data: {
      tokenAddress: TEST_TOKEN,
      tokenSymbol: 'USDC',
      buyAmountSol: 0.1
    },
    validator: (data) => data.providers && data.bestProvider
  });

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