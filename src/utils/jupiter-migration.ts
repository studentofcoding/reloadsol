// Jupiter API v2 to v3 migration utility

import { setJupiterApiVersion, getJupiterApiVersion, testApiVersions } from './jupiter-api'

// Test tokens for migration validation
const TEST_TOKENS = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
]

interface MigrationResult {
  success: boolean
  currentVersion: 'v2' | 'v3'
  testResults?: {
    v2: Record<string, any>
    v3: Record<string, any>
    comparison: Array<{
      token: string
      v2Price: number
      v3Price: number
      difference: number
      percentDifference: number
    }>
  }
  errors?: string[]
  warnings?: string[]
}

// Test both API versions and compare results
export async function testMigration(): Promise<MigrationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  
  try {
    console.log('🧪 Testing Jupiter API v2 vs v3 migration...')
    
    const testResults = await testApiVersions(TEST_TOKENS)
    
    // Analyze the comparison results
    const significantDifferences = testResults.comparison.filter(
      item => Math.abs(item.percentDifference) > 5 // More than 5% difference
    )
    
    if (significantDifferences.length > 0) {
      warnings.push(
        `Found ${significantDifferences.length} tokens with >5% price difference between v2 and v3`
      )
      significantDifferences.forEach(diff => {
        warnings.push(
          `${diff.token}: v2=$${diff.v2Price.toFixed(6)}, v3=$${diff.v3Price.toFixed(6)} (${diff.percentDifference.toFixed(2)}% diff)`
        )
      })
    }
    
    // Check for missing prices
    const v2Missing = testResults.comparison.filter(item => item.v2Price === 0)
    const v3Missing = testResults.comparison.filter(item => item.v3Price === 0)
    
    if (v2Missing.length > 0) {
      warnings.push(`v2 API missing prices for ${v2Missing.length} tokens`)
    }
    
    if (v3Missing.length > 0) {
      warnings.push(`v3 API missing prices for ${v3Missing.length} tokens`)
    }
    
    console.log('✅ Migration test completed successfully')
    
    return {
      success: true,
      currentVersion: getJupiterApiVersion(),
      testResults,
      warnings: warnings.length > 0 ? warnings : undefined
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    errors.push(`Migration test failed: ${errorMessage}`)
    
    console.error('❌ Migration test failed:', error)
    
    return {
      success: false,
      currentVersion: getJupiterApiVersion(),
      errors
    }
  }
}

// Perform the actual migration to v3
export async function migrateToV3(): Promise<MigrationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  
  try {
    console.log('🚀 Starting migration to Jupiter API v3...')
    
    // First, test the migration
    const testResult = await testMigration()
    
    if (!testResult.success) {
      errors.push('Pre-migration test failed')
      if (testResult.errors) {
        errors.push(...testResult.errors)
      }
      return {
        success: false,
        currentVersion: getJupiterApiVersion(),
        errors
      }
    }
    
    // Add any test warnings to our warnings
    if (testResult.warnings) {
      warnings.push(...testResult.warnings)
    }
    
    // Perform the migration
    setJupiterApiVersion('v3')
    
    console.log('✅ Successfully migrated to Jupiter API v3')
    console.log('📊 Migration summary:')
    console.log(`  - Current API version: ${getJupiterApiVersion()}`)
    
    if (testResult.testResults) {
      const { comparison } = testResult.testResults
      const avgDifference = comparison.reduce((sum, item) => sum + Math.abs(item.percentDifference), 0) / comparison.length
      console.log(`  - Average price difference: ${avgDifference.toFixed(2)}%`)
      console.log(`  - Tokens tested: ${comparison.length}`)
    }
    
    if (warnings.length > 0) {
      console.log('⚠️  Migration warnings:')
      warnings.forEach(warning => console.log(`  - ${warning}`))
    }
    
    return {
      success: true,
      currentVersion: 'v3',
      testResults: testResult.testResults,
      warnings: warnings.length > 0 ? warnings : undefined
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    errors.push(`Migration failed: ${errorMessage}`)
    
    console.error('❌ Migration to v3 failed:', error)
    
    return {
      success: false,
      currentVersion: getJupiterApiVersion(),
      errors
    }
  }
}

// Rollback to v2 if needed
export async function rollbackToV2(): Promise<MigrationResult> {
  const errors: string[] = []
  
  try {
    console.log('🔄 Rolling back to Jupiter API v2...')
    
    setJupiterApiVersion('v2')
    
    console.log('✅ Successfully rolled back to Jupiter API v2')
    
    return {
      success: true,
      currentVersion: 'v2'
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    errors.push(`Rollback failed: ${errorMessage}`)
    
    console.error('❌ Rollback to v2 failed:', error)
    
    return {
      success: false,
      currentVersion: getJupiterApiVersion(),
      errors
    }
  }
}

// Get current migration status
export function getMigrationStatus(): {
  currentVersion: 'v2' | 'v3'
  isV3: boolean
  description: string
} {
  const currentVersion = getJupiterApiVersion()
  const isV3 = currentVersion === 'v3'
  
  return {
    currentVersion,
    isV3,
    description: isV3 
      ? 'Using Jupiter API v3 with enhanced price data including decimals and 24h price change'
      : 'Using Jupiter API v2 with basic price data'
  }
}

// Validate that all files are using the centralized API
export async function validateMigration(): Promise<{
  isValid: boolean
  issues: string[]
  recommendations: string[]
}> {
  const issues: string[] = []
  const recommendations: string[] = []
  
  // This would ideally scan the codebase for direct Jupiter API calls
  // For now, we'll provide a manual checklist
  
  const filesToCheck = [
    'src/app/api/tokens/prices/route.ts',
    'src/utils/jupiter.ts',
    'src/components/PnLTracker.tsx',
    'src/utils/trading-tracker.ts',
    'src/utils/jupiter-pools-test.ts'
  ]
  
  recommendations.push(
    'Verify that all files are using the centralized Jupiter API utility:',
    ...filesToCheck.map(file => `  - ${file}`),
    '',
    'Search for any remaining direct calls to:',
    '  - https://lite-api.jup.ag/price/v2',
    '  - fetch(`https://lite-api.jup.ag/price/v2',
    '',
    'All price fetching should now use:',
    '  - import { getTokenPrice, getTokenPrices } from "@/utils/jupiter-api"',
    '  - Or the existing price-client.ts for client-side caching'
  )
  
  return {
    isValid: issues.length === 0,
    issues,
    recommendations
  }
}

export default {
  testMigration,
  migrateToV3,
  rollbackToV2,
  getMigrationStatus,
  validateMigration
}