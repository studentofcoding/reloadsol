#!/usr/bin/env node

/**
 * Trending Token Tracker - Manual Test Script
 * 
 * Usage:
 *   node scripts/test-trending-tracker.js track     # Test 5-minute tracking
 *   node scripts/test-trending-tracker.js summary   # Test 24-hour summary  
 *   node scripts/test-trending-tracker.js stats     # Test stats endpoint
 *   node scripts/test-trending-tracker.js all       # Test all endpoints
 */

const https = require('https');
const http = require('http');

// Configuration - All values now configurable via environment variables
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.TEST_BASE_URL || 'https://reloadsol.app';

const SECRET_KEY = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending';
const CONTENT_TYPE = process.env.TEST_CONTENT_TYPE || 'application/json';
const USER_AGENT = process.env.TEST_USER_AGENT || 'trending-tracker-test-script';
const EXPECTED_UNAUTHORIZED_STATUS = parseInt(process.env.TEST_EXPECTED_UNAUTHORIZED_STATUS) || 401;
const EXPECTED_NOT_FOUND_STATUS = parseInt(process.env.TEST_EXPECTED_NOT_FOUND_STATUS) || 404;
const GAIN_TOLERANCE = parseFloat(process.env.TEST_GAIN_TOLERANCE) || 0.01;
const SAMPLE_LOG_COUNT = parseInt(process.env.TEST_SAMPLE_LOG_COUNT) || 3;
const TOP_WINNERS_DISPLAY_COUNT = parseInt(process.env.TEST_TOP_WINNERS_COUNT) || 3;

// Helper function to make HTTP requests
function makeRequest(url, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;

    const options = {
      method,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'User-Agent': USER_AGENT
      }
    };

    const req = lib.request(url, options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const jsonData = JSON.parse(responseData);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: jsonData
          });
        } catch (error) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: responseData
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test functions
// Add near the top with other configs
const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true';

async function testTracking() {
  console.log('🔍 Testing 5-minute tracking endpoint...');
  console.log(`URL: ${BASE_URL}/api/trending/track?key=${SECRET_KEY}`);

  try {
    const result = await makeRequest(`${BASE_URL}/api/trending/track?key=${SECRET_KEY}`, 'POST');

    console.log(`Status: ${result.status}`);

    if (result.status === 200) {
      console.log('✅ Tracking endpoint successful!');
      console.log('📊 Results:');
      console.log(`  • Processed: ${result.data.processed || 0} tokens`);
      console.log(`  • New tokens added: ${result.data.new_tokens_added || 0}`);
      console.log(`  • Tokens updated: ${result.data.tokens_updated || 0}`);
      console.log(`  • Tokens lost: ${result.data.tokens_lost || 0}`);

      // Enhanced logging for token stopping
      if (VERBOSE_LOGGING && result.data.stopped_tokens) {
        console.log('🛑 Stopped Tokens Details:');
        result.data.stopped_tokens.forEach(token => {
          console.log(`  • ${token.symbol || token.address}: Stopped due to ${token.stop_reason || 'unknown'}`);
        });
      }

      if (result.data.current_stats) {
        console.log(`  • Currently tracking: ${result.data.current_stats.tracking || 0}`);
        console.log(`  • Total won: ${result.data.current_stats.won || 0}`);
        console.log(`  • Total lost: ${result.data.current_stats.lost || 0}`);
      }
    } else {
      console.log('❌ Tracking endpoint failed!');
      console.log('Error:', result.data);
      if (VERBOSE_LOGGING) {
        console.log('Full error response:', JSON.stringify(result, null, 2));
      }
    }
  } catch (error) {
    console.log('❌ Request failed:', error.message);
    if (VERBOSE_LOGGING) {
      console.log('Error details:', error);
    }
  }

  console.log('');
}

async function testSummary() {
  console.log('📊 Testing 24-hour summary endpoint...');
  console.log(`URL: ${BASE_URL}/api/trending/summary?key=${SECRET_KEY}`);

  try {
    const result = await makeRequest(`${BASE_URL}/api/trending/summary?key=${SECRET_KEY}`, 'POST');

    console.log(`Status: ${result.status}`);

    if (result.status === 200) {
      console.log('✅ Summary endpoint successful!');
      console.log('📈 Summary:');

      if (result.data.statistics) {
        const stats = result.data.statistics;
        console.log(`  • Total tracked: ${stats.total_tokens_tracked || 0}`);
        console.log(`  • Won: ${stats.won_tokens || 0}`);
        console.log(`  • Lost: ${stats.lost_tokens || 0}`);
        console.log(`  • Still tracking: ${stats.still_tracking || 0}`);
        console.log(`  • Win rate: ${stats.win_rate || 0}%`);
        console.log(`  • Avg peak gain: ${stats.avg_peak_gain || 0}%`);
        console.log(`  • Max peak gain: ${stats.max_peak_gain || 0}%`);
      }

      if (result.data.top_winners && result.data.top_winners.length > 0) {
        console.log('🏆 Top winners:');
        result.data.top_winners.slice(0, TOP_WINNERS_DISPLAY_COUNT).forEach((winner, index) => {
          console.log(`  ${index + 1}. ${winner.token_symbol || 'Unknown'}: +${winner.peak_gain_percentage.toFixed(2)}%`);
        });
      }

      console.log(`📝 ${result.data.message || 'Summary completed'}`);
    } else {
      console.log('❌ Summary endpoint failed!');
      console.log('Error:', result.data);
    }
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }

  console.log('');
}

async function testStats() {
  console.log('📋 Testing stats endpoint...');
  console.log(`URL: ${BASE_URL}/api/trending/stats`);

  try {
    const result = await makeRequest(`${BASE_URL}/api/trending/stats`);

    console.log(`Status: ${result.status}`);

    if (result.status === 200) {
      console.log('✅ Stats endpoint successful!');
      console.log('📊 Current status:');

      if (result.data.current_tracking) {
        const current = result.data.current_tracking;
        console.log(`  • Currently tracking: ${current.statistics.total_tracking || 0} tokens`);
        console.log(`  • Positive performers: ${current.statistics.positive_performers || 0}`);
        console.log(`  • Negative performers: ${current.statistics.negative_performers || 0}`);
        console.log(`  • At risk (>-40%): ${current.statistics.at_risk || 0}`);

        if (current.statistics.top_performer) {
          const top = current.statistics.top_performer;
          console.log(`  • Top performer: ${top.token_symbol} (${top.peak_gain_percentage.toFixed(2)}%)`);
        }

        console.log(`  • Avg current gain: ${current.averages.current_gain}%`);
        console.log(`  • Avg peak gain: ${current.averages.peak_gain}%`);
      }

      if (result.data.latest_summary) {
        const summary = result.data.latest_summary;
        console.log('🗓️  Latest 24h summary:');
        console.log(`  • Win rate: ${summary.win_rate}%`);
        console.log(`  • Total tracked: ${summary.total_tokens_tracked}`);
        console.log(`  • Won: ${summary.won_tokens}, Lost: ${summary.lost_tokens}`);
      }

      if (result.data.data_freshness) {
        const freshness = result.data.data_freshness;
        console.log('⏰ Data freshness:');
        console.log(`  • Tracking tokens: ${freshness.tracking_tokens_count}`);
        if (freshness.latest_summary_age_hours !== null) {
          console.log(`  • Last summary: ${freshness.latest_summary_age_hours.toFixed(1)}h ago`);
        }
      }
    } else {
      console.log('❌ Stats endpoint failed!');
      console.log('Error:', result.data);
    }
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }

  console.log('');
}

// Add new test functions for specific features
async function testGainCalculations() {
  console.log('📊 Testing gain calculations...');

  const testCases = [
    {
      name: 'Basic gain calculation',
      initial: 1.0,
      current: 1.5,
      expected: 50
    },
    {
      name: 'Zero initial price',
      initial: 0,
      current: 1.0,
      expected: 0 // Should handle zero initial price gracefully
    },
    {
      name: 'Negative gain',
      initial: 2.0,
      current: 1.0,
      expected: -50
    },
    {
      name: 'Peak price update',
      initial: 1.0,
      current: 2.0,
      peak: 1.5,
      expectedPeak: 2.0
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log(`\n🧪 Testing: ${test.name}`);

    try {
      const result = await makeRequest(`${BASE_URL}/api/trending/track/test-gains`, 'POST', {
        initial_price: test.initial,
        current_price: test.current,
        peak_price: test.peak
      });

      if (result.status === 200) {
        const data = result.data;
        let testPassed = true;

        if ('gain_percentage' in data) {
          const gainDiff = Math.abs(data.gain_percentage - test.expected);
          if (gainDiff > GAIN_TOLERANCE) {
            console.log('❌ Gain calculation failed');
            console.log(`  Expected: ${test.expected}%`);
            console.log(`  Got: ${data.gain_percentage}%`);
            testPassed = false;
          }
        }

        if (test.peak !== undefined && 'new_peak_price' in data) {
          if (data.new_peak_price !== test.expectedPeak) {
            console.log('❌ Peak price calculation failed');
            console.log(`  Expected: ${test.expectedPeak}`);
            console.log(`  Got: ${data.new_peak_price}`);
            testPassed = false;
          }
        }

        if (testPassed) {
          console.log('✅ Test passed');
          passed++;
        } else {
          failed++;
        }
      } else {
        console.log('❌ Test failed - Bad response');
        console.log('Error:', result.data);
        failed++;
      }
    } catch (error) {
      console.log('❌ Test failed - Request error:', error.message);
      failed++;
    }
  }

  console.log(`\n📝 Results: ${passed} passed, ${failed} failed\n`);
}

async function testErrorHandling() {
  console.log('🔬 Testing error handling...');

  const testCases = [
    {
      name: 'Missing auth key',
      url: '/api/trending/track',
      method: 'POST',
      expectedStatus: EXPECTED_UNAUTHORIZED_STATUS
    },
    {
      name: 'Invalid auth key',
      url: '/api/trending/track?key=invalid',
      method: 'POST',
      expectedStatus: EXPECTED_UNAUTHORIZED_STATUS
    },
    {
      name: 'Invalid endpoint',
      url: '/api/trending/invalid',
      method: 'GET',
      expectedStatus: EXPECTED_NOT_FOUND_STATUS
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log(`\n🧪 Testing: ${test.name}`);

    try {
      const result = await makeRequest(`${BASE_URL}${test.url}`, test.method);

      if (result.status === test.expectedStatus) {
        console.log('✅ Test passed');
        console.log(`  Expected status: ${test.expectedStatus}`);
        console.log(`  Got status: ${result.status}`);
        passed++;
      } else {
        console.log('❌ Test failed - Unexpected status code');
        console.log(`  Expected: ${test.expectedStatus}`);
        console.log(`  Got: ${result.status}`);
        failed++;
      }
    } catch (error) {
      if (test.expectedStatus >= 400) {
        console.log('✅ Test passed - Expected error');
        passed++;
      } else {
        console.log('❌ Test failed - Unexpected error:', error.message);
        failed++;
      }
    }
  }

  console.log(`\n📝 Results: ${passed} passed, ${failed} failed\n`);
}

async function testLogging() {
  console.log('📝 Testing logging functionality...');

  const testCases = [
    {
      name: 'Normal operation logging',
      operation: 'track',
      params: { simulate: true }
    },
    {
      name: 'Error logging',
      operation: 'track',
      params: { simulate: true, force_error: true }
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    console.log(`\n🧪 Testing: ${test.name}`);

    try {
      const result = await makeRequest(
        `${BASE_URL}/api/trending/${test.operation}?key=${SECRET_KEY}`,
        'POST',
        test.params
      );

      // Check if logs field exists in response
      if (result.data.logs) {
        console.log('✅ Logging test passed');
        console.log('📋 Sample logs:');
        result.data.logs.slice(0, SAMPLE_LOG_COUNT).forEach(log => {
          console.log(`  • ${log.operation}: ${log.message}`);
        });
        passed++;
      } else {
        console.log('❌ Logging test failed - No logs in response');
        failed++;
      }
    } catch (error) {
      console.log('❌ Logging test failed:', error.message);
      failed++;
    }
  }

  console.log(`\n📝 Results: ${passed} passed, ${failed} failed\n`);
}

// Main execution
async function main() {
  const command = process.argv[2] || 'help';

  console.log('🚀 Trending Token Tracker - Test Suite');
  console.log(`📡 Base URL: ${BASE_URL}`);
  console.log(`🔑 Using secret key: ${SECRET_KEY}`);
  console.log('');

  switch (command.toLowerCase()) {
    case 'track':
    case 'tracking':
      await testTracking();
      break;

    case 'summary':
      await testSummary();
      break;

    case 'stats':
      await testStats();
      break;

    case 'gains':
      await testGainCalculations();
      break;

    case 'errors':
      await testErrorHandling();
      break;

    case 'logs':
      await testLogging();
      break;

    case 'full':
      console.log('🔬 Running full test suite...\n');
      await testGainCalculations();
      await testErrorHandling();
      await testLogging();
      await testStats();
      await testTracking();
      await testSummary();
      break;

    case 'all':
      await testStats();
      await testTracking();
      await testSummary();
      break;

    case 'help':
    default:
      console.log('📖 Usage:');
      console.log('  node scripts/test-trending-tracker.js track     # Test 5-minute tracking');
      console.log('  node scripts/test-trending-tracker.js summary   # Test 24-hour summary');
      console.log('  node scripts/test-trending-tracker.js stats     # Test stats endpoint');
      console.log('  node scripts/test-trending-tracker.js gains     # Test gain calculations');
      console.log('  node scripts/test-trending-tracker.js errors    # Test error handling');
      console.log('  node scripts/test-trending-tracker.js logs      # Test logging functionality');
      console.log('  node scripts/test-trending-tracker.js full      # Run full test suite');
      console.log('  node scripts/test-trending-tracker.js all       # Test basic endpoints');
      console.log('');
      console.log('💡 Environment variables:');
      console.log('  VERCEL_URL                      - Base URL for production');
      console.log('  TEST_BASE_URL                   - Base URL for testing (default: http://localhost:3000)');
      console.log('  TRENDING_TRACKER_SECRET         - API secret key');
      console.log('  TEST_CONTENT_TYPE               - HTTP Content-Type header (default: application/json)');
      console.log('  TEST_USER_AGENT                 - HTTP User-Agent header (default: trending-tracker-test-script)');
      console.log('  TEST_EXPECTED_UNAUTHORIZED_STATUS - Expected HTTP status for unauthorized requests (default: 401)');
      console.log('  TEST_EXPECTED_NOT_FOUND_STATUS  - Expected HTTP status for not found requests (default: 404)');
      console.log('  TEST_GAIN_TOLERANCE             - Tolerance for gain calculation tests (default: 0.01)');
      console.log('  TEST_SAMPLE_LOG_COUNT           - Number of sample logs to display (default: 3)');
      console.log('  TEST_TOP_WINNERS_COUNT          - Number of top winners to display (default: 3)');
      break;
  }
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error.message);
  process.exit(1);
});

// Run the script
main().catch((error) => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});