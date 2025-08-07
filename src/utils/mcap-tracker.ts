import { supabase } from '@/utils/supabase'

export interface McapSnapshot {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  first_seen_at: string
  last_updated_at: string
  mcap_growth_percent: number
}

export interface McapTrackingResult {
  isFirstTime: boolean
  firstMcap?: number
  currentMcap: number
  growthPercent?: number
  formattedGrowth?: string
  firstSeenAt?: string
}

// Cache for MCap data to avoid frequent database calls
const mcapCache = new Map<string, McapSnapshot>()
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes cache

// Helper function to convert MCap to integer (round to nearest dollar)
function normalizeMarketCap(mcap: number): number {
  return Math.round(mcap)
}

// Helper function to format timestamp to GMT+7
function formatTimestampGMT7(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  // GMT+7 is UTC+7, so add 7 hours
  const gmt7Date = new Date(date.getTime() + (7 * 60 * 60 * 1000))
  
  const hours = gmt7Date.getUTCHours().toString().padStart(2, '0')
  const minutes = gmt7Date.getUTCMinutes().toString().padStart(2, '0')
  
  return `${hours}:${minutes} GMT+7`
}

// Function to track MCap for a token
export async function trackTokenMcap(
  tokenAddress: string,
  tokenSymbol: string,
  currentMcap: number
): Promise<McapTrackingResult> {
  try {
    // Normalize MCap to integer
    const normalizedCurrentMcap = normalizeMarketCap(currentMcap)
    
    // Check cache first
    const cached = mcapCache.get(tokenAddress)
    const now = Date.now()
    
    if (cached && (now - new Date(cached.last_updated_at).getTime()) < CACHE_TTL_MS) {
      // Use cached data but update current MCap if different
      if (Math.abs(cached.current_mcap - normalizedCurrentMcap) > cached.current_mcap * 0.01) { // 1% threshold
        cached.current_mcap = normalizedCurrentMcap
        cached.last_updated_at = new Date().toISOString()
        cached.mcap_growth_percent = ((normalizedCurrentMcap - cached.first_mcap) / cached.first_mcap) * 100
        
        // Update database asynchronously
        updateMcapInDatabase(cached).catch(console.error)
      }
      
      return {
        isFirstTime: false,
        firstMcap: cached.first_mcap,
        currentMcap: cached.current_mcap,
        growthPercent: cached.mcap_growth_percent,
        formattedGrowth: formatGrowthPercent(cached.mcap_growth_percent),
        firstSeenAt: cached.first_seen_at
      }
    }

    // Check database for existing record
    const { data: existingRecord, error } = await supabase
      .from('token_mcap_tracking')
      .select('*')
      .eq('token_address', tokenAddress)
      .single()

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error fetching MCap record:', error)
      return { isFirstTime: true, currentMcap: normalizedCurrentMcap }
    }

    const currentTime = new Date().toISOString()

    if (existingRecord) {
      // Token exists, update current MCap
      const growthPercent = ((normalizedCurrentMcap - existingRecord.first_mcap) / existingRecord.first_mcap) * 100
      
      const updatedRecord: McapSnapshot = {
        ...existingRecord,
        current_mcap: normalizedCurrentMcap,
        last_updated_at: currentTime,
        mcap_growth_percent: growthPercent
      }

      // Update cache
      mcapCache.set(tokenAddress, updatedRecord)

      // Update database asynchronously if MCap changed significantly
      if (Math.abs(existingRecord.current_mcap - normalizedCurrentMcap) > existingRecord.current_mcap * 0.01) {
        updateMcapInDatabase(updatedRecord).catch(console.error)
      }

      return {
        isFirstTime: false,
        firstMcap: existingRecord.first_mcap,
        currentMcap: normalizedCurrentMcap,
        growthPercent,
        formattedGrowth: formatGrowthPercent(growthPercent),
        firstSeenAt: existingRecord.first_seen_at
      }
    } else {
      // First time seeing this token
      const newRecord: McapSnapshot = {
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        first_mcap: normalizedCurrentMcap,
        current_mcap: normalizedCurrentMcap,
        first_seen_at: currentTime,
        last_updated_at: currentTime,
        mcap_growth_percent: 0
      }

      // Add to cache
      mcapCache.set(tokenAddress, newRecord)

      // Insert into database asynchronously
      insertMcapRecord(newRecord).catch(console.error)

      return {
        isFirstTime: true,
        currentMcap: normalizedCurrentMcap,
        firstSeenAt: currentTime
      }
    }
  } catch (error) {
    console.error('Error in trackTokenMcap:', error)
    return { isFirstTime: true, currentMcap: normalizeMarketCap(currentMcap) }
  }
}

// Helper function to insert new MCap record
async function insertMcapRecord(record: McapSnapshot): Promise<void> {
  try {
    const { error } = await supabase
      .from('token_mcap_tracking')
      .insert({
        token_address: record.token_address,
        token_symbol: record.token_symbol,
        first_mcap: record.first_mcap,
        current_mcap: record.current_mcap,
        first_seen_at: record.first_seen_at,
        last_updated_at: record.last_updated_at,
        mcap_growth_percent: record.mcap_growth_percent
      })

    if (error) {
      console.error('Error inserting MCap record:', error)
    }
  } catch (error) {
    console.error('Error in insertMcapRecord:', error)
  }
}

// Helper function to update MCap record
async function updateMcapInDatabase(record: McapSnapshot): Promise<void> {
  try {
    const { error } = await supabase
      .from('token_mcap_tracking')
      .update({
        current_mcap: record.current_mcap,
        last_updated_at: record.last_updated_at,
        mcap_growth_percent: record.mcap_growth_percent
      })
      .eq('token_address', record.token_address)

    if (error) {
      console.error('Error updating MCap record:', error)
    }
  } catch (error) {
    console.error('Error in updateMcapInDatabase:', error)
  }
}

// Helper function to format growth percentage
function formatGrowthPercent(growthPercent: number): string {
  const sign = growthPercent >= 0 ? '+' : ''
  return `${sign}${growthPercent.toFixed(1)}%`
}

// Function to get MCap display string for Discord
export function getMcapDisplayString(trackingResult: McapTrackingResult): string {
  if (trackingResult.isFirstTime) {
    const timeStr = trackingResult.firstSeenAt ?
      ` (1st seen: ${formatTimestampGMT7(trackingResult.firstSeenAt)})` : ''
    return `MCap: $${trackingResult.currentMcap.toLocaleString()}${timeStr}`
  }

  const firstMcapStr = trackingResult.firstMcap!.toLocaleString()
  const currentMcapStr = trackingResult.currentMcap.toLocaleString()
  const growthEmoji = trackingResult.growthPercent! >= 0 ? '📈' : '📉'
  const timeStr = trackingResult.firstSeenAt ?
    `, 1st seen: ${formatTimestampGMT7(trackingResult.firstSeenAt)}` : ''

  return `MCap: $${currentMcapStr} (${growthEmoji} ${trackingResult.formattedGrowth} from $${firstMcapStr}${timeStr})`
}

// Function to check if token is in tracking range
export function isInTrackingRange(mcap: number): boolean {
  return mcap >= 30_000 && mcap <= 2_000_000 // 30k to 2M range
}

// Function to clean up old records (can be called periodically)
export async function cleanupOldMcapRecords(daysOld: number = 30): Promise<void> {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    const { error } = await supabase
      .from('token_mcap_tracking')
      .delete()
      .lt('last_updated_at', cutoffDate.toISOString())

    if (error) {
      console.error('Error cleaning up old MCap records:', error)
    } else {
      console.log(`Cleaned up MCap records older than ${daysOld} days`)
    }
  } catch (error) {
    console.error('Error in cleanupOldMcapRecords:', error)
  }
}

// Function to get bulk MCap tracking for multiple tokens
export async function bulkTrackTokenMcaps(
  tokens: Array<{ address: string; symbol: string; mcap: number }>
): Promise<Map<string, McapTrackingResult>> {
  const results = new Map<string, McapTrackingResult>()

  // Process tokens in parallel but limit concurrency
  const BATCH_SIZE = 10
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE)
    const batchPromises = batch.map(async token => {
      const result = await trackTokenMcap(token.address, token.symbol, token.mcap)
      return { address: token.address, result }
    })

    const batchResults = await Promise.all(batchPromises)
    batchResults.forEach(({ address, result }) => {
      results.set(address, result)
    })
  }

  return results
}