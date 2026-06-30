// Load environment variables from .env file
require('dotenv').config({ path: __dirname + '/../.env.local' })
require('dotenv').config({ path: __dirname + '/../.env' })

const { query, closePool } = require('./db-client')

const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

async function fixInvalidPrices() {
    console.log('Starting price validation cleanup...')

    try {
        const { rows: invalidTokens } = await query(
            `SELECT * FROM ${TRACKER_TABLE}
             WHERE initial_price_usd <= 0 OR last_price_usd <= 0
                OR initial_price_usd IS NULL OR last_price_usd IS NULL`,
        )

        console.log(`Found ${invalidTokens?.length || 0} tokens with invalid price data`)

        let fixed = 0
        let defaulted = 0

        for (const token of invalidTokens || []) {
            console.log(`Processing ${token.token_symbol} (${token.token_address})`)

            try {
                const priceResp = await fetch(`https://reloadsol.app/api/tokens/prices?tokens=${token.token_address}`)

                if (priceResp.ok) {
                    const { priceUsd } = await priceResp.json()

                    if (priceUsd && priceUsd > 0) {
                        const sets = []
                        const params = []
                        let idx = 1

                        if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                            sets.push(`initial_price_usd = $${idx++}`)
                            params.push(priceUsd)
                        }

                        if (!token.last_price_usd || token.last_price_usd <= 0) {
                            sets.push(`last_price_usd = $${idx++}`)
                            params.push(priceUsd)
                        }

                        if (sets.length > 0) {
                            params.push(token.id)
                            await query(
                                `UPDATE ${TRACKER_TABLE} SET ${sets.join(', ')} WHERE id = $${idx}`,
                                params,
                            )
                            console.log(`✅ Updated ${token.token_symbol} with current price: $${priceUsd}`)
                            fixed++
                        }
                    } else {
                        const sets = []
                        const params = []
                        let idx = 1

                        if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                            sets.push(`initial_price_usd = $${idx++}`)
                            params.push(0.000001)
                        }

                        if (!token.last_price_usd || token.last_price_usd <= 0) {
                            sets.push(`last_price_usd = $${idx++}`)
                            params.push(0.000001)
                        }

                        if (sets.length > 0) {
                            params.push(token.id)
                            await query(
                                `UPDATE ${TRACKER_TABLE} SET ${sets.join(', ')} WHERE id = $${idx}`,
                                params,
                            )
                            console.log(`⚠️ Set ${token.token_symbol} to default minimal price`)
                            defaulted++
                        }
                    }
                } else {
                    const sets = []
                    const params = []
                    let idx = 1

                    if (!token.initial_price_usd || token.initial_price_usd <= 0) {
                        sets.push(`initial_price_usd = $${idx++}`)
                        params.push(0.000001)
                    }

                    if (!token.last_price_usd || token.last_price_usd <= 0) {
                        sets.push(`last_price_usd = $${idx++}`)
                        params.push(0.000001)
                    }

                    if (sets.length > 0) {
                        params.push(token.id)
                        await query(
                            `UPDATE ${TRACKER_TABLE} SET ${sets.join(', ')} WHERE id = $${idx}`,
                            params,
                        )
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
    } finally {
        await closePool()
    }
}

if (require.main === module) {
    fixInvalidPrices()
}

module.exports = { fixInvalidPrices }
