import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'

// Use alternate tables in local development to avoid prod collisions
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams

        // Extract query parameters
        const status = searchParams.get('status') || 'all'
        const dateRange = searchParams.get('dateRange') || 'all'
        const minGain = searchParams.get('minGain')
        const maxGain = searchParams.get('maxGain')
        const minDuration = searchParams.get('minDuration')
        const maxDuration = searchParams.get('maxDuration')
        const sortBy = searchParams.get('sortBy') || 'created_at'
        const sortOrder = searchParams.get('sortOrder') || 'desc'
        const search = searchParams.get('search')
        const page = parseInt(searchParams.get('page') || '1')
        const limit = parseInt(searchParams.get('limit') || '20')

        console.log('📊 Fetching token tracking history with filters:', {
            status, dateRange, minGain, maxGain, minDuration, maxDuration, sortBy, sortOrder, search, page, limit
        })

        // First, let's check the total unfiltered count to see how many records exist
        const { count: totalUnfilteredCount, error: totalCountError } = await supabase
            .from(TRACKER_TABLE)
            .select('*', { count: 'exact', head: true })

        if (totalCountError) {
            console.error('Error getting total unfiltered count:', totalCountError)
        } else {
            console.log(`🔍 Total unfiltered records in database: ${totalUnfilteredCount}`)
        }

        // Helper function to apply filters to any query
        const applyFilters = (query: any) => {
            // Apply status filter
            if (status !== 'all') {
                console.log(`🔍 Applying status filter: ${status}`)
                query = query.eq('status', status)
            }

            // Apply date range filter
            if (dateRange !== 'all') {
                const now = new Date()
                const cutoff = new Date()

                switch (dateRange) {
                    case '24h':
                        cutoff.setHours(now.getHours() - 24)
                        break
                    case '7d':
                        cutoff.setDate(now.getDate() - 7)
                        break
                    case '30d':
                        cutoff.setDate(now.getDate() - 30)
                        break
                    case '90d':
                        cutoff.setDate(now.getDate() - 90)
                        break
                }

                console.log(`🔍 Applying date range filter: ${dateRange}, cutoff: ${cutoff.toISOString()}`)
                query = query.gte('created_at', cutoff.toISOString())
            }

            // Apply search filter
            if (search && search.trim()) {
                const searchTerm = search.toLowerCase()
                console.log(`🔍 Applying search filter: ${searchTerm}`)
                query = query.or(`token_symbol.ilike.%${searchTerm}%,token_name.ilike.%${searchTerm}%,token_address.ilike.%${searchTerm}%`)
            }

            // Apply gain filters
            if (minGain) {
                const minGainNum = parseFloat(minGain)
                if (!isNaN(minGainNum)) {
                    console.log(`🔍 Applying min gain filter: ${minGainNum}`)
                    query = query.gte('peak_gain_percentage', minGainNum)
                }
            }

            if (maxGain) {
                const maxGainNum = parseFloat(maxGain)
                if (!isNaN(maxGainNum)) {
                    console.log(`🔍 Applying max gain filter: ${maxGainNum}`)
                    query = query.lte('peak_gain_percentage', maxGainNum)
                }
            }

            // Apply duration filters
            if (minDuration) {
                const minDurationNum = parseFloat(minDuration)
                if (!isNaN(minDurationNum)) {
                    console.log(`🔍 Applying min duration filter: ${minDurationNum} hours`)
                    // Calculate duration in hours using SQL
                    query = query.gte('EXTRACT(EPOCH FROM (COALESCE(status_changed_at, NOW()) - tracking_started_at))/3600', minDurationNum)
                }
            }

            if (maxDuration) {
                const maxDurationNum = parseFloat(maxDuration)
                if (!isNaN(maxDurationNum)) {
                    console.log(`🔍 Applying max duration filter: ${maxDurationNum} hours`)
                    // Calculate duration in hours using SQL
                    query = query.lte('EXTRACT(EPOCH FROM (COALESCE(status_changed_at, NOW()) - tracking_started_at))/3600', maxDurationNum)
                }
            }

            return query
        }

        // Prepare queries
        let countQuery = supabase
            .from(TRACKER_TABLE)
            .select('*', { count: 'exact', head: true })
        countQuery = applyFilters(countQuery)

        let dataQuery = supabase
            .from(TRACKER_TABLE)
            .select('*')
        dataQuery = applyFilters(dataQuery)
        
        // Apply sorting and pagination to data query
        const ascending = sortOrder === 'asc'
        dataQuery = dataQuery.order(sortBy, { ascending })
        const offset = (page - 1) * limit
        dataQuery = dataQuery.range(offset, offset + limit - 1)

        // Stats query (global stats)
        const statsQuery = supabase
            .from(TRACKER_TABLE)
            .select('status, peak_gain_percentage')

        // Execute all queries in parallel
        const [countResult, dataResult, statsResult] = await Promise.all([
            countQuery,
            dataQuery,
            statsQuery
        ])

        const { count, error: countError } = countResult
        const { data, error } = dataResult
        const { data: allTokens, error: statsError } = statsResult

        if (countError) console.error('Error getting filtered count:', countError)
        if (error) throw new Error(`Database error: ${error.message}`)

        console.log(`📊 Filtered count: ${count} tokens (unfiltered: ${totalUnfilteredCount})`)

        let stats = {
            total: 0,
            won: 0,
            lost: 0,
            tracking: 0,
            waiting: 0,
            skipped: 0,
            winRate: 0,
            avgPeakGain: 0
        }

        if (!statsError && allTokens) {
            stats.total = allTokens.length
            stats.won = allTokens.filter(t => t.status === 'won').length
            stats.lost = allTokens.filter(t => t.status === 'lost').length
            stats.tracking = allTokens.filter(t => t.status === 'tracking').length
            stats.waiting = allTokens.filter(t => t.status === 'waiting').length
            stats.skipped = allTokens.filter(t => t.status === 'skipped').length

            const completedTokens = stats.won + stats.lost
            stats.winRate = completedTokens > 0 ? (stats.won / completedTokens) * 100 : 0
            stats.avgPeakGain = allTokens.length > 0 ? allTokens.reduce((sum, t) => sum + (t.peak_gain_percentage || 0), 0) / allTokens.length : 0
        }

        const totalPages = Math.ceil((count || 0) / limit)

        console.log(`📄 Pagination: page ${page}/${totalPages}, limit ${limit}, offset ${offset}`)

        console.log(`✅ Fetched ${data?.length || 0} tokens (page ${page}/${totalPages}, filtered total: ${count})`)

        return NextResponse.json({
            success: true,
            data: data || [],
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            },
            stats,
            filters: {
                status,
                dateRange,
                minGain,
                maxGain,
                minDuration,
                maxDuration,
                sortBy,
                sortOrder,
                search
            },
            timestamp: new Date().toISOString()
        })

    } catch (error) {
        console.error('❌ Error in tracking history API:', error)
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch tracking history',
                timestamp: new Date().toISOString()
            },
            { status: 500 }
        )
    }
}