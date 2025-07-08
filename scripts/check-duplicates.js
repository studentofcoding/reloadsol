#!/usr/bin/env node

/**
 * Script to check for duplicate tokens and diagnose database issues
 * Usage: node scripts/check-duplicates.js
 */

const { createClient } = require('@supabase/supabase-js')

// Configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const TABLE_NAME = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase environment variables')
  console.error('   NEXT_PUBLIC_SUPABASE_URL')
  console.error('   NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

async function checkDuplicates() {
  try {
    console.log('🔍 Checking for duplicate tokens in database...')
    console.log(`📊 Table: ${TABLE_NAME}`)
    
    // Get all tokens
    const { data: allTokens, error } = await supabase
      .from(TABLE_NAME)
      .select('id, token_address, token_symbol, status, tracking_started_at, updated_at')
      .order('token_address')
    
    if (error) {
      throw new Error(`Failed to fetch tokens: ${error.message}`)
    }
    
    console.log(`📈 Total tokens in database: ${allTokens.length}`)
    
    // Group by token_address to find duplicates
    const addressGroups = new Map()
    
    allTokens.forEach(token => {
      if (!addressGroups.has(token.token_address)) {
        addressGroups.set(token.token_address, [])
      }
      addressGroups.get(token.token_address).push(token)
    })
    
    // Find duplicates
    const duplicates = []
    addressGroups.forEach((tokens, address) => {
      if (tokens.length > 1) {
        duplicates.push({ address, tokens })
      }
    })
    
    if (duplicates.length === 0) {
      console.log('✅ No duplicate token addresses found!')
    } else {
      console.log(`⚠️  Found ${duplicates.length} duplicate token addresses:`)
      console.log('')
      
      duplicates.forEach(({ address, tokens }) => {
        console.log(`🔄 Token Address: ${address}`)
        tokens.forEach((token, index) => {
          const age = Math.round((Date.now() - new Date(token.updated_at).getTime()) / (1000 * 60 * 60))
          console.log(`   ${index + 1}. ID: ${token.id}`)
          console.log(`      Symbol: ${token.token_symbol}`)
          console.log(`      Status: ${token.status}`)
          console.log(`      Age: ${age}h`)
          console.log(`      Started: ${token.tracking_started_at}`)
        })
        console.log('')
      })
    }
    
    // Status summary
    const statusSummary = new Map()
    allTokens.forEach(token => {
      statusSummary.set(token.status, (statusSummary.get(token.status) || 0) + 1)
    })
    
    console.log('📊 Status Summary:')
    statusSummary.forEach((count, status) => {
      console.log(`   ${status}: ${count}`)
    })
    
    // Recent activity
    const recent = allTokens.filter(token => {
      const age = (Date.now() - new Date(token.updated_at).getTime()) / (1000 * 60 * 60)
      return age < 24 // Last 24 hours
    })
    
    console.log(``)
    console.log(`🕐 Recent activity (last 24h): ${recent.length} tokens`)
    
    const tracking = allTokens.filter(t => t.status === 'tracking')
    console.log(`🎯 Currently tracking: ${tracking.length} tokens`)
    
  } catch (error) {
    console.error('❌ Error checking duplicates:', error.message)
    process.exit(1)
  }
}

async function cleanupDuplicates() {
  try {
    console.log('🧹 Starting duplicate cleanup...')
    
    // Get all tokens grouped by address
    const { data: allTokens, error } = await supabase
      .from(TABLE_NAME)
      .select('id, token_address, token_symbol, status, tracking_started_at, updated_at')
      .order('updated_at', { ascending: false }) // Newest first
    
    if (error) {
      throw new Error(`Failed to fetch tokens: ${error.message}`)
    }
    
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
        // Keep the newest one, mark others for deletion
        console.log(`🔄 Address ${address} has ${tokens.length} duplicates`)
        
        // Sort by priority: tracking > won > lost, then by newest
        tokens.sort((a, b) => {
          const statusPriority = { tracking: 3, won: 2, lost: 1 }
          const aPriority = statusPriority[a.status] || 0
          const bPriority = statusPriority[b.status] || 0
          
          if (aPriority !== bPriority) {
            return bPriority - aPriority // Higher priority first
          }
          
          // Same status, prefer newer
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
    
    // In a real cleanup, you'd want confirmation here
    console.log('💡 Add confirmation prompt if you want to actually delete these records')
    
    // Uncomment the following to actually perform cleanup:
    /*
    const { error: deleteError } = await supabase
      .from(TABLE_NAME)
      .delete()
      .in('id', toDelete)
    
    if (deleteError) {
      throw new Error(`Failed to delete duplicates: ${deleteError.message}`)
    }
    
    console.log('✅ Cleanup completed!')
    */
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error.message)
    process.exit(1)
  }
}

// Main execution
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
    console.log('  NEXT_PUBLIC_SUPABASE_URL     # Supabase project URL')
    console.log('  NEXT_PUBLIC_SUPABASE_ANON_KEY # Supabase anon key')
    console.log('  NODE_ENV                     # development or production')
    process.exit(1)
} 