#!/usr/bin/env node

/**
 * Script to check for duplicate tokens and diagnose database issues
 * Usage: node scripts/check-duplicates.js
 */

require('dotenv').config({ path: __dirname + '/../.env.local' })
require('dotenv').config({ path: __dirname + '/../.env' })

const { query, closePool } = require('./db-client')

const TABLE_NAME = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

async function checkDuplicates() {
  try {
    console.log('🔍 Checking for duplicate tokens in database...')
    console.log(`📊 Table: ${TABLE_NAME}`)

    const { rows: allTokens } = await query(
      `SELECT id, token_address, token_symbol, status, tracking_started_at, updated_at
       FROM ${TABLE_NAME}
       ORDER BY token_address`,
    )

    console.log(`📈 Total tokens in database: ${allTokens.length}`)

    const addressGroups = new Map()

    allTokens.forEach(token => {
      if (!addressGroups.has(token.token_address)) {
        addressGroups.set(token.token_address, [])
      }
      addressGroups.get(token.token_address).push(token)
    })

    const duplicates = []
    addressGroups.forEach((tokens, address) => {
      if (tokens.length > 1) {
        duplicates.push({ address, tokens })
      }
    })

    if (duplicates.length === 0) {
      console.log('✅ No duplicate token addresses found!')
    } else {
      console.log(`⚠️  Found ${duplicates.length} addresses with duplicates:`)
      duplicates.forEach(({ address, tokens }) => {
        console.log(`\n📍 ${address} (${tokens.length} records):`)
        tokens.forEach(t => {
          console.log(`   - ${t.id} | ${t.token_symbol} | ${t.status} | updated: ${t.updated_at}`)
        })
      })
    }

    const recent = allTokens.filter(t => {
      const updated = new Date(t.updated_at)
      return Date.now() - updated.getTime() < 24 * 60 * 60 * 1000
    })
    console.log(`🕐 Recent activity (last 24h): ${recent.length} tokens`)

    const tracking = allTokens.filter(t => t.status === 'tracking')
    console.log(`🎯 Currently tracking: ${tracking.length} tokens`)

  } catch (error) {
    console.error('❌ Error checking duplicates:', error.message)
    process.exit(1)
  } finally {
    await closePool()
  }
}

async function cleanupDuplicates() {
  try {
    console.log('🧹 Starting duplicate cleanup...')

    const { rows: allTokens } = await query(
      `SELECT id, token_address, token_symbol, status, tracking_started_at, updated_at
       FROM ${TABLE_NAME}
       ORDER BY updated_at DESC`,
    )

    const addressGroups = new Map()
    allTokens.forEach(token => {
      if (!addressGroups.has(token.token_address)) {
        addressGroups.set(token.token_address, [])
      }
      addressGroups.get(token.token_address).push(token)
    })

    const toDelete = []

    addressGroups.forEach((tokens, address) => {
      if (tokens.length > 1) {
        console.log(`🔄 Address ${address} has ${tokens.length} duplicates`)

        tokens.sort((a, b) => {
          const statusPriority = { tracking: 3, won: 2, lost: 1 }
          const aPriority = statusPriority[a.status] || 0
          const bPriority = statusPriority[b.status] || 0

          if (aPriority !== bPriority) {
            return bPriority - aPriority
          }

          return new Date(b.updated_at) - new Date(a.updated_at)
        })

        const keep = tokens[0]
        const duplicates = tokens.slice(1)

        console.log(`   ✅ Keeping: ${keep.id} (${keep.status}, ${keep.token_symbol})`)
        duplicates.forEach(dup => {
          console.log(`   ❌ Deleting: ${dup.id} (${dup.status}, ${dup.token_symbol})`)
          toDelete.push(dup.id)
        })
      }
    })

    if (toDelete.length === 0) {
      console.log('✅ No duplicates to clean up!')
      return
    }

    console.log(``)
    console.log(`🗑️  Will delete ${toDelete.length} duplicate records`)
    console.log('⚠️  This action cannot be undone!')
    console.log('💡 Add confirmation prompt if you want to actually delete these records')

  } catch (error) {
    console.error('❌ Error during cleanup:', error.message)
    process.exit(1)
  } finally {
    await closePool()
  }
}

const command = process.argv[2]

switch (command) {
  case 'check':
  case undefined:
    checkDuplicates()
    break

  case 'cleanup':
    cleanupDuplicates()
    break

  default:
    console.log('🔍 Database Duplicate Checker')
    console.log('')
    console.log('Usage:')
    console.log('  node scripts/check-duplicates.js check    # Check for duplicates (default)')
    console.log('  node scripts/check-duplicates.js cleanup  # Preview cleanup actions')
    console.log('')
    console.log('Environment variables needed:')
    console.log('  DATABASE_URL or DATABASE_URL_DIRECT')
    console.log('  NODE_ENV                     # development or production')
    process.exit(1)
}
