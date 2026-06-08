// Load environment variables from .env file
require('dotenv').config({ path: __dirname + '/.env' })

const { createClient } = require('@supabase/supabase-js')

// Try both possible environment variable names
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY

if (!supabaseUrl) {
    console.error('❌ Supabase URL not found. Please set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL environment variable.')
    process.exit(1)
}

if (!supabaseKey) {
    console.error('❌ Supabase key not found. Please set SUPABASE_ANON_KEY environment variable.')
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

async function fixInvalidPrices() {
    console.log('Starting price validation cleanup...')
    console.log('Using Supabase URL:', supabaseUrl.substring(0, 30) + '...')

    try {
        // Find tokens with invalid price data (only checking initial_price_usd and last_price_usd)
        const { data: invalidTokens, error: fetchError } = await supabase
            .from(TRACKER_TABLE)
            .select('*')
            .or('initial_price_usd.lte.0,last_price_usd.lte.0')

        if (fetchError) throw fetchError

        console.log(`Found ${invalidTokens?.length || 0} tokens with invalid price data`)

        let fixed = 0
        let defaulted = 0

        for (const token of invalidTokens || []) {
            console.log(`Processing ${token.token_symbol} (${token.token_address})`)

            try {
                // Try to fetch current price
                const priceResp = await fetch(`https://v2.reloadsol.xyz/api/tokens/prices?tokens=${token.token_address}`)

                if (priceResp.ok) {
                    const { priceUsd } = await priceResp.json()

                    if (priceUsd && priceUsd > 0) {
                        // Update with valid current price
                        const updateData = {}

                        // Fix initial_price_usd if invalid
                        if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                            updateData.initial_price_usd = priceUsd
                        }

                        // Fix last_price_usd if invalid
                        if (!token.last_price_usd || token.last_price_usd <= 0) {
                            updateData.last_price_usd = priceUsd
                        }

                        if (Object.keys(updateData).length > 0) {
                            const { error: updateError } = await supabase
                                .from(TRACKER_TABLE)
                                .update(updateData)
                                .eq('id', token.id)

                            if (updateError) throw updateError

                            console.log(`✅ Updated ${token.token_symbol} with current price: $${priceUsd}`)
                            fixed++
                        }
                    } else {
                        // Set to minimal valid default if no valid price available
                        const updateData = {}

                        if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                            updateData.initial_price_usd = 0.000001
                        }

                        if (!token.last_price_usd || token.last_price_usd <= 0) {
                            updateData.last_price_usd = 0.000001
                        }

                        if (Object.keys(updateData).length > 0) {
                            const { error: updateError } = await supabase
                                .from(TRACKER_TABLE)
                                .update(updateData)
                                .eq('id', token.id)

                            if (updateError) throw updateError

                            console.log(`⚠️ Set ${token.token_symbol} to default minimal price`)
                            defaulted++
                        }
                    }
                } else {
                    // Set to minimal valid default if API call fails
                    const updateData = {}

                    if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                        updateData.initial_price_usd = 0.000001
                    }

                    if (!token.last_price_usd || token.last_price_usd <= 0) {
                        updateData.last_price_usd = 0.000001
                    }

                    if (Object.keys(updateData).length > 0) {
                        const { error: updateError } = await supabase
                            .from(TRACKER_TABLE)
                            .update(updateData)
                            .eq('id', token.id)

                        if (updateError) throw updateError

                        console.log(`⚠️ Set ${token.token_symbol} to default minimal price (API failed)`)
                        defaulted++
                    }
                }
            } catch (error) {
                console.error(`❌ Error processing ${token.token_symbol}:`, error.message)
            }
        }

        console.log('\n📊 Cleanup Summary:')
        console.log(`✅ Fixed with current prices: ${fixed}`)
        console.log(`⚠️ Set to default values: ${defaulted}`)
        console.log(`📝 Total processed: ${fixed + defaulted}`)

    } catch (error) {
        console.error('❌ Error during cleanup:', error)
        process.exit(1)
    }
}

if (require.main === module) {
    fixInvalidPrices()
}

module.exports = { fixInvalidPrices }