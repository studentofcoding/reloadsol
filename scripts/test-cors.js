#!/usr/bin/env node

/**
 * CORS Testing Script for Trending API
 * Tests cross-origin requests to identify CORS configuration issues
 */

const https = require('https');
const http = require('http');

// Configuration
const config = {
    targetUrl: 'https://reloadsol.app/api/trending',
    testOrigins: [
        'https://reloadsol.xyz',
        'https://testing.reloadsol.xyz',
        'https://reloadsol.app',
        'http://localhost:3000',
        'https://example.com' // Should fail
    ]
};

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function makeRequest(url, origin, method = 'GET') {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                'Origin': origin,
                'User-Agent': 'CORS-Test-Script/1.0',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = client.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    data: data,
                    origin: origin,
                    method: method
                });
            });
        });

        req.on('error', (error) => {
            reject({
                error: error.message,
                origin: origin,
                method: method
            });
        });

        req.setTimeout(10000, () => {
            req.destroy();
            reject({
                error: 'Request timeout',
                origin: origin,
                method: method
            });
        });

        req.end();
    });
}

function analyzeResponse(response) {
    const corsHeaders = {
        'access-control-allow-origin': response.headers['access-control-allow-origin'],
        'access-control-allow-methods': response.headers['access-control-allow-methods'],
        'access-control-allow-headers': response.headers['access-control-allow-headers'],
        'access-control-max-age': response.headers['access-control-max-age']
    };

    const hasCorsHeaders = Object.values(corsHeaders).some(value => value !== undefined);
    const allowsOrigin = corsHeaders['access-control-allow-origin'] === response.origin ||
        corsHeaders['access-control-allow-origin'] === '*';

    return {
        corsHeaders,
        hasCorsHeaders,
        allowsOrigin,
        statusOk: response.statusCode >= 200 && response.statusCode < 300
    };
}

function printResults(response, analysis) {
    const status = response.statusCode;
    const statusColor = status >= 200 && status < 300 ? 'green' : 'red';

    log(`\n${'='.repeat(60)}`, 'cyan');
    log(`Origin: ${response.origin}`, 'bright');
    log(`Method: ${response.method}`, 'bright');
    log(`Status: ${status}`, statusColor);

    log(`\nCORS Headers:`, 'yellow');
    Object.entries(analysis.corsHeaders).forEach(([key, value]) => {
        const color = value ? 'green' : 'red';
        log(`  ${key}: ${value || 'NOT SET'}`, color);
    });

    log(`\nAnalysis:`, 'magenta');
    log(`  Has CORS Headers: ${analysis.hasCorsHeaders ? 'YES' : 'NO'}`, analysis.hasCorsHeaders ? 'green' : 'red');
    log(`  Allows Origin: ${analysis.allowsOrigin ? 'YES' : 'NO'}`, analysis.allowsOrigin ? 'green' : 'red');
    log(`  Status OK: ${analysis.statusOk ? 'YES' : 'NO'}`, analysis.statusOk ? 'green' : 'red');

    if (response.error) {
        log(`\nError: ${response.error}`, 'red');
    }

    // Show first 200 chars of response data
    if (response.data && response.data.length > 0) {
        const preview = response.data.substring(0, 200);
        log(`\nResponse Preview: ${preview}${response.data.length > 200 ? '...' : ''}`, 'blue');
    }
}

async function testPreflight(url, origin) {
    log(`\nTesting OPTIONS preflight for origin: ${origin}`, 'cyan');

    try {
        const response = await makeRequest(url, origin, 'OPTIONS');
        const analysis = analyzeResponse(response);
        printResults(response, analysis);
        return analysis;
    } catch (error) {
        log(`Preflight failed: ${error.error || error.message}`, 'red');
        return { error: true };
    }
}

async function testActualRequest(url, origin) {
    log(`\nTesting GET request for origin: ${origin}`, 'cyan');

    try {
        const response = await makeRequest(url, origin, 'GET');
        const analysis = analyzeResponse(response);
        printResults(response, analysis);
        return analysis;
    } catch (error) {
        log(`Request failed: ${error.error || error.message}`, 'red');
        return { error: true };
    }
}

async function runTests() {
    log('🧪 Starting CORS Testing for Trending API', 'bright');
    log(`Target URL: ${config.targetUrl}`, 'blue');
    log(`Testing ${config.testOrigins.length} origins`, 'blue');

    const results = [];

    for (const origin of config.testOrigins) {
        log(`\n${'*'.repeat(80)}`, 'yellow');
        log(`Testing Origin: ${origin}`, 'bright');

        // Test preflight (OPTIONS)
        const preflightResult = await testPreflight(config.targetUrl, origin);

        // Test actual request (GET)
        const requestResult = await testActualRequest(config.targetUrl, origin);

        results.push({
            origin,
            preflight: preflightResult,
            request: requestResult
        });

        // Wait a bit between tests
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Summary
    log(`\n${'='.repeat(80)}`, 'green');
    log('📊 SUMMARY', 'bright');
    log(`${'='.repeat(80)}`, 'green');

    results.forEach(result => {
        const preflightOk = result.preflight.allowsOrigin && result.preflight.statusOk;
        const requestOk = result.request.allowsOrigin && result.request.statusOk;

        log(`\n${result.origin}:`, 'bright');
        log(`  Preflight (OPTIONS): ${preflightOk ? 'PASS' : 'FAIL'}`, preflightOk ? 'green' : 'red');
        log(`  Request (GET): ${requestOk ? 'PASS' : 'FAIL'}`, requestOk ? 'green' : 'red');
    });

    // Recommendations
    log(`\n${'='.repeat(80)}`, 'yellow');
    log('💡 RECOMMENDATIONS', 'bright');
    log(`${'='.repeat(80)}`, 'yellow');

    const failedOrigins = results.filter(r =>
        !r.preflight.allowsOrigin || !r.request.allowsOrigin
    );

    if (failedOrigins.length === 0) {
        log('✅ All origins are working correctly!', 'green');
    } else {
        log('❌ Issues found:', 'red');
        failedOrigins.forEach(result => {
            log(`  - ${result.origin}: Check middleware configuration`, 'red');
        });

        log('\nSuggested fixes:', 'yellow');
        log('1. Verify middleware.ts is deployed correctly', 'yellow');
        log('2. Check server logs for middleware execution', 'yellow');
        log('3. Clear all caches (browser, CDN, edge)', 'yellow');
        log('4. Add explicit CORS headers to API route', 'yellow');
    }
}

// Browser-compatible test function
function generateBrowserTest() {
    const browserTest = `
// Run this in browser console on https://reloadsol.xyz
fetch('${config.targetUrl}', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log('✅ Response Status:', response.status);
  console.log('📋 Response Headers:');
  for (let [key, value] of response.headers.entries()) {
    console.log('  ' + key + ':', value);
  }
  return response.json();
})
.then(data => {
  console.log('📦 Response Data:', data);
})
.catch(error => {
  console.error('❌ Error:', error);
});
  `;

    log('\n🌐 Browser Test Code:', 'cyan');
    log('Copy and paste this into browser console on https://reloadsol.xyz:', 'blue');
    log(browserTest, 'green');
}

// Main execution
if (require.main === module) {
    runTests()
        .then(() => {
            generateBrowserTest();
            log('\n✨ Testing complete!', 'green');
        })
        .catch(error => {
            log(`\n💥 Test suite failed: ${error.message}`, 'red');
            process.exit(1);
        });
}

module.exports = {
    makeRequest,
    testPreflight,
    testActualRequest,
    runTests
};