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

// Configuration
const BASE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}` 
  : 'http://localhost:3000';

const SECRET_KEY = process.env.TRENDING_TRACKER_SECRET || 'trending-track-secret';

// Helper function to make HTTP requests
function makeRequest(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'trending-tracker-test-script'
      }
    };

    const req = lib.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: jsonData
          });
        } catch (error) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: data
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Test functions
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
      
      if (result.data.current_stats) {
        console.log(`  • Currently tracking: ${result.data.current_stats.tracking || 0}`);
        console.log(`  • Total won: ${result.data.current_stats.won || 0}`);
        console.log(`  • Total lost: ${result.data.current_stats.lost || 0}`);
      }
    } else {
      console.log('❌ Tracking endpoint failed!');
      console.log('Error:', result.data);
    }
  } catch (error) {
    console.log('❌ Request failed:', error.message);
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
        result.data.top_winners.slice(0, 3).forEach((winner, index) => {
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

// Main execution
async function main() {
  const command = process.argv[2] || 'help';
  
  console.log('🚀 Trending Token Tracker - Test Script');
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
      console.log('  node scripts/test-trending-tracker.js all       # Test all endpoints');
      console.log('');
      console.log('💡 Environment variables:');
      console.log('  VERCEL_URL                - Base URL (default: localhost:3000)');
      console.log('  TRENDING_TRACKER_SECRET   - API secret key');
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