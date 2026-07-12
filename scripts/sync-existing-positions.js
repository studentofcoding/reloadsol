#!/usr/bin/env node

// Script to sync existing open positions to SL/TP tracker
// Usage: node scripts/sync-existing-positions.js [wallet_address] [options]

// Configuration - matches other scripts
const API_HOST = process.env.API_HOST || 'https://reloadsol.app';
const LOCAL_API_HOST = 'http://localhost:3000';

// Utility functions for consistent logging
const log = {
    success: (msg) => console.log('✅ ' + msg),
    error: (msg) => console.log('❌ ' + msg),
    info: (msg) => console.log('ℹ️  ' + msg),
    warning: (msg) => console.log('⚠️  ' + msg),
    header: (msg) => console.log('\n' + '='.repeat(50) + '\n' + msg + '\n' + '='.repeat(50))
};

// Validate Solana wallet address format
function validateWalletAddress(address) {
    if (!address || typeof address !== 'string') {
        return false;
    }

    // Solana public key is 32 bytes base58 encoded (typically 32-44 characters)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
}

// Enhanced sync function with better error handling and options
async function syncExistingPositions(walletAddress, options = {}) {
    const {
        useLocal = false,
        defaultStopLossPercentage = -20,
        defaultTakeProfitPercentage = 50,
        botTp1Percentage = 50,
        botTp1SellPercentage = 90,
        botTp2Percentage = 90,
        botTp3Percentage = 150,
        botTp3Enabled = true,
        verbose = false
    } = options;

    // Validate wallet address
    if (!validateWalletAddress(walletAddress)) {
        log.error('Invalid wallet address format');
        log.info('Wallet address should be a valid Solana public key (32-44 base58 characters)');
        return false;
    }

    const apiHost = useLocal ? LOCAL_API_HOST : API_HOST;
    console.log(`Syncing existing positions for wallet: ${walletAddress}...`);

    try {
        log.info(`Using API host: ${apiHost}`);

        // Construct URL with parameters
        const params = new URLSearchParams({
            action: 'sync',
            wallet: walletAddress
        });

        // Add optional parameters if provided
        if (defaultStopLossPercentage !== -20) params.set('defaultStopLossPercentage', String(defaultStopLossPercentage));
        if (defaultTakeProfitPercentage !== 50) params.set('defaultTakeProfitPercentage', String(defaultTakeProfitPercentage));
        if (botTp1Percentage !== 10) params.set('botTp1Percentage', String(botTp1Percentage));
        if (botTp1SellPercentage !== 25) params.set('botTp1SellPercentage', String(botTp1SellPercentage));
        if (botTp2Percentage !== 25) params.set('botTp2Percentage', String(botTp2Percentage));
        if (botTp3Percentage !== 50) params.set('botTp3Percentage', String(botTp3Percentage));
        if (!botTp3Enabled) params.set('botTp3Enabled', 'false');

        if (verbose) {
            log.info('Request parameters:');
            console.log(Object.fromEntries(params));
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
        try {
            response = await fetch(`${apiHost}/api/sl-tp-monitor?${params}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }

        console.log('API request completed');

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            log.error(`HTTP ${response.status}: ${response.statusText}`);
            if (data?.error) log.error(`Server error: ${data.error}`);
            if (verbose && data) console.log('Error response:', JSON.stringify(data, null, 2));
            return false;
        }

        if (data.success) {
            log.header('Sync Results');
            log.success('Sync completed successfully!');

            const result = data.result;
            console.log(`📊 Summary:`);
            console.log(`   ✅ Synced: ${result.synced} positions`);
            console.log(`   ⏭️  Skipped: ${result.skipped} positions (already tracked)`);
            console.log(`   ❌ Errors: ${result.errors} positions`);

            if (verbose && data.details) {
                log.info('Detailed results:');
                console.log(JSON.stringify(data.details, null, 2));
            }

            return true;
        } else {
            log.error(`Sync failed: ${data.error || 'Unknown error'}`);

            if (verbose && data) {
                console.log('Full response:', JSON.stringify(data, null, 2));
            }

            return false;
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            log.error('No response received from server (timeout)');
            log.warning('Check if the API server is running and accessible');
            if (useLocal) log.info('Try running the development server: npm run dev');
        } else if (error.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error.message)) {
            log.error('No response received from server');
            log.warning('Check if the API server is running and accessible');
            if (useLocal) log.info('Try running the development server: npm run dev');
        } else {
            log.error(`Request setup error: ${error.message}`);
        }

        if (verbose) {
            console.log('Full error:', error);
        }

        return false;
    }
}

// Command line argument parsing
function parseArguments() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log('\n📋 SL/TP Position Sync Script');
        console.log('\nUsage:');
        console.log('  node scripts/sync-existing-positions.js <wallet_address> [options]');
        console.log('\nOptions:');
        console.log('  --local                    Use local API (http://localhost:3000)');
        console.log('  --stop-loss <percentage>   Default stop loss percentage (default: -20)');
        console.log('  --take-profit <percentage> Default take profit percentage (default: 50)');
        console.log('  --verbose                  Show detailed output');
        console.log('  --help, -h                 Show this help message');
        console.log('\nExamples:');
        console.log('  node scripts/sync-existing-positions.js DGJqRtDKdBiKfXGwgQbaC5YJW3PGd5TtE2tGmKSLtVwx');
        console.log('  node scripts/sync-existing-positions.js <wallet> --local --verbose');
        console.log('  node scripts/sync-existing-positions.js <wallet> --stop-loss -15 --take-profit 30');
        process.exit(0);
    }

    const walletAddress = args[0];
    const options = {
        useLocal: args.includes('--local'),
        verbose: args.includes('--verbose')
    };

    // Parse numeric options
    const stopLossIndex = args.indexOf('--stop-loss');
    if (stopLossIndex !== -1 && args[stopLossIndex + 1]) {
        options.defaultStopLossPercentage = parseFloat(args[stopLossIndex + 1]);
    }

    const takeProfitIndex = args.indexOf('--take-profit');
    if (takeProfitIndex !== -1 && args[takeProfitIndex + 1]) {
        options.defaultTakeProfitPercentage = parseFloat(args[takeProfitIndex + 1]);
    }

    return { walletAddress, options };
}

// Main execution
async function main() {
    try {
        const { walletAddress, options } = parseArguments();

        if (!walletAddress) {
            log.error('Please provide a wallet address');
            log.info('Use --help for usage information');
            process.exit(1);
        }

        log.header('SL/TP Position Sync');
        log.info(`Wallet: ${walletAddress}`);

        if (options.useLocal) {
            log.warning('Using local API endpoint');
        }

        const success = await syncExistingPositions(walletAddress, options);

        if (success) {
            log.success('\n🎉 Sync operation completed successfully!');
            process.exit(0);
        } else {
            log.error('\n💥 Sync operation failed');
            process.exit(1);
        }

    } catch (error) {
        log.error(`Unexpected error: ${error.message}`);
        process.exit(1);
    }
}

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Run the script
main();
