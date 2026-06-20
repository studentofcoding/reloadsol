#!/usr/bin/env node

// Script to sync existing open positions to SL/TP tracker
// Usage: node scripts/sync-existing-positions.js [wallet_address] [options]

const axios = require('axios');
const chalk = require('chalk');
const ora = require('ora');

// Configuration - matches other scripts
const API_HOST = process.env.API_HOST || 'https://reloadsol.app';
const LOCAL_API_HOST = 'http://localhost:3000';

// Utility functions for consistent logging
const log = {
    success: (msg) => console.log(chalk.green('✅ ' + msg)),
    error: (msg) => console.log(chalk.red('❌ ' + msg)),
    info: (msg) => console.log(chalk.blue('ℹ️  ' + msg)),
    warning: (msg) => console.log(chalk.yellow('⚠️  ' + msg)),
    header: (msg) => console.log(chalk.cyan.bold('\n' + '='.repeat(50) + '\n' + msg + '\n' + '='.repeat(50)))
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
    const spinner = ora(`Syncing existing positions for wallet: ${walletAddress}`).start();

    try {
        log.info(`Using API host: ${apiHost}`);

        // Construct URL with parameters
        const url = `${apiHost}/api/sl-tp-monitor`;
        const params = {
            action: 'sync',
            wallet: walletAddress
        };

        // Add optional parameters if provided
        if (defaultStopLossPercentage !== -20) params.defaultStopLossPercentage = defaultStopLossPercentage;
        if (defaultTakeProfitPercentage !== 50) params.defaultTakeProfitPercentage = defaultTakeProfitPercentage;
        if (botTp1Percentage !== 10) params.botTp1Percentage = botTp1Percentage;
        if (botTp1SellPercentage !== 25) params.botTp1SellPercentage = botTp1SellPercentage;
        if (botTp2Percentage !== 25) params.botTp2Percentage = botTp2Percentage;
        if (botTp3Percentage !== 50) params.botTp3Percentage = botTp3Percentage;
        if (!botTp3Enabled) params.botTp3Enabled = false;

        if (verbose) {
            log.info('Request parameters:');
            console.log(chalk.gray(JSON.stringify(params, null, 2)));
        }

        const response = await axios({
            url,
            method: 'GET',
            params,
            timeout: 30000, // 30 second timeout
            headers: {
                'Content-Type': 'application/json'
            }
        });

        spinner.succeed('API request completed');

        if (response.data.success) {
            log.header('Sync Results');
            log.success('Sync completed successfully!');

            const result = response.data.result;
            console.log(chalk.white(`📊 Summary:`));
            console.log(chalk.green(`   ✅ Synced: ${result.synced} positions`));
            console.log(chalk.yellow(`   ⏭️  Skipped: ${result.skipped} positions (already tracked)`));
            console.log(chalk.red(`   ❌ Errors: ${result.errors} positions`));

            if (verbose && response.data.details) {
                log.info('Detailed results:');
                console.log(chalk.gray(JSON.stringify(response.data.details, null, 2)));
            }

            return true;
        } else {
            spinner.fail('Sync failed');
            log.error(`Sync failed: ${response.data.error || 'Unknown error'}`);

            if (verbose && response.data) {
                console.log(chalk.gray('Full response:', JSON.stringify(response.data, null, 2)));
            }

            return false;
        }

    } catch (error) {
        spinner.fail('Request failed');

        if (error.response) {
            // Server responded with error status
            log.error(`HTTP ${error.response.status}: ${error.response.statusText}`);

            if (error.response.data?.error) {
                log.error(`Server error: ${error.response.data.error}`);
            }

            if (verbose && error.response.data) {
                console.log(chalk.gray('Error response:', JSON.stringify(error.response.data, null, 2)));
            }
        } else if (error.request) {
            // Request was made but no response received
            log.error('No response received from server');
            log.warning('Check if the API server is running and accessible');

            if (useLocal) {
                log.info('Try running the development server: npm run dev');
            }
        } else {
            // Something else happened
            log.error(`Request setup error: ${error.message}`);
        }

        if (verbose) {
            console.log(chalk.gray('Full error:', error));
        }

        return false;
    }
}

// Command line argument parsing
function parseArguments() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(chalk.cyan.bold('\n📋 SL/TP Position Sync Script'));
        console.log(chalk.white('\nUsage:'));
        console.log(chalk.gray('  node scripts/sync-existing-positions.js <wallet_address> [options]'));
        console.log(chalk.white('\nOptions:'));
        console.log(chalk.gray('  --local                    Use local API (http://localhost:3000)'));
        console.log(chalk.gray('  --stop-loss <percentage>   Default stop loss percentage (default: -20)'));
        console.log(chalk.gray('  --take-profit <percentage> Default take profit percentage (default: 50)'));
        console.log(chalk.gray('  --verbose                  Show detailed output'));
        console.log(chalk.gray('  --help, -h                 Show this help message'));
        console.log(chalk.white('\nExamples:'));
        console.log(chalk.gray('  node scripts/sync-existing-positions.js DGJqRtDKdBiKfXGwgQbaC5YJW3PGd5TtE2tGmKSLtVwx'));
        console.log(chalk.gray('  node scripts/sync-existing-positions.js <wallet> --local --verbose'));
        console.log(chalk.gray('  node scripts/sync-existing-positions.js <wallet> --stop-loss -15 --take-profit 30'));
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