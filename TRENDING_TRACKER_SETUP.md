# Trending Token Tracking System

## 🎯 Overview

The Trending Token Tracking System automatically monitors trending tokens from Jupiter API, tracks their price performance over 24-hour periods, and generates win/loss statistics with leaderboards.

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Vercel Cron    │───▶│   Next.js API    │───▶│    Supabase     │
│  Jobs (2 new)   │    │   Routes (3 new) │    │   (2 new tables)│
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │   Dev Frontend   │
                       │   Tracking Page  │
                       └──────────────────┘
```

## 🚀 Setup Instructions

### 1. Database Setup
Run the SQL migration in your Supabase SQL Editor:

```bash
# Copy and paste the contents of trending_tracker_migration.sql
# This creates the trending_token_tracker and trending_token_summary tables
```

### 2. Environment Variables (Optional)
Add to your `.env.local`:

```bash
TRENDING_TRACKER_SECRET=your-secret-key-here
```
*(Defaults to `trending-track-secret` if not set)*

### 3. Deploy to Vercel
The system is automatically deployed with your Next.js app. Vercel cron jobs are configured in `vercel.json`:

- **5-minute tracking**: `*/5 * * * *` - Updates token prices, checks for losses
- **24-hour summary**: `0 0 * * *` - Generates daily reports and identifies winners

**🔧 Smart Authentication**: Cron jobs are automatically authenticated via Vercel headers - no secret key needed in URLs!

## 📊 How It Works

### 5-Minute Price Tracking (`/api/trending/track`)
1. **Fetches** trending tokens from Jupiter API
2. **Filters** tokens by criteria:
   - Organic score ≥ 70
   - Market cap: $300K - $2M  
   - Not dropping >40% in 5 minutes
3. **Updates** existing tracked tokens:
   - Current price and gain/loss percentages
   - Peak price achieved
   - Marks tokens as "lost" if they drop >50% from initial price
4. **Adds** new trending tokens to tracking list

### 24-Hour Summary Generation (`/api/trending/summary`)
1. **Analyzes** all tokens tracked in the last 24 hours
2. **Identifies** top 5 performers by peak gain percentage
3. **Marks** top performers as "won"
4. **Calculates** win rate: `wins / (wins + losses) * 100`
5. **Generates** leaderboard and summary statistics
6. **Stores** results in `trending_token_summary` table

### Frontend Dashboard (`/dev/trending-tracker`)
- **Real-time stats** with 30-second auto-refresh
- **Enhanced price updates**: Manual "Refresh Stats + Prices" button fetches fresh prices
- **Overview tab**: Latest summary, win rates, top performers
- **Tracking tab**: Currently monitored tokens with live P&L
- **Winners/Losers tabs**: Recent completed trades
- **Debug mode**: Detailed API response logging and testing controls

## 📋 Database Schema

### `trending_token_tracker`
```sql
- id: Unique identifier
- token_address: Solana token mint address
- token_symbol/name/logo_url: Token metadata
- initial_price_usd: Price when tracking started
- last_price_usd: Most recent price
- peak_price_usd: Highest price achieved
- current_gain_percentage: Current % change from initial
- peak_gain_percentage: Best % performance achieved
- status: 'tracking' | 'won' | 'lost'
- tracking_started_at: When monitoring began
- status_changed_at: When marked as won/lost
```

### `trending_token_summary`
```sql
- id: Unique summary identifier
- period_start/end: 24-hour window
- total_tokens_tracked: Number of tokens monitored
- won_tokens/lost_tokens: Win/loss counts
- win_rate: Percentage of successful picks
- top_winners: JSON array of top 5 performers
- avg_peak_gain/max_peak_gain: Performance metrics
- avg_loss: Average loss percentage
```

## 🔧 API Endpoints

### `/api/trending/track` (POST)
**Purpose**: 5-minute price updates  
**Trigger**: Vercel cron every 5 minutes  
**Auth**: `?key=trending-track-secret`

**Response**:
```json
{
  "success": true,
  "processed": 25,
  "new_tokens_added": 3,
  "tokens_updated": 20,
  "tokens_lost": 2,
  "current_stats": {
    "tracking": 15,
    "won": 8,
    "lost": 12
  }
}
```

### `/api/trending/summary` (POST)
**Purpose**: Daily summary generation  
**Trigger**: Vercel cron daily at midnight  
**Auth**: `?key=trending-track-secret`

**Response**:
```json
{
  "success": true,
  "statistics": {
    "total_tokens_tracked": 50,
    "won_tokens": 8,
    "lost_tokens": 12,
    "win_rate": 66.67
  },
  "top_winners": [...],
  "message": "Summary complete: 8 wins, 12 losses, 66.7% win rate"
}
```

### `/api/trending/stats` (GET)
**Purpose**: Frontend data source  
**Cache**: 5 minutes  
**Public**: Yes

**Response**: Complete dashboard data including current tracking, recent summaries, and trends.

## 📈 Key Metrics

### Win Rate Calculation
```
Win Rate = (Won Tokens) / (Won Tokens + Lost Tokens) * 100
```

### Token Status Logic
- **Tracking**: Currently monitoring price movements
- **Won**: Top 5 performers in 24-hour period (marked during summary)
- **Lost**: Dropped >50% from initial price (marked during 5-min updates)

### Performance Thresholds
- **Loss threshold**: -50% from initial price
- **Winner selection**: Top 5 by peak gain percentage
- **Risk warning**: Tokens at -40% (close to loss threshold)

## 🎮 Usage

### Access the Dashboard
Navigate to `/dev/trending-tracker` to view:
- Real-time win rates and performance metrics
- Currently tracked tokens with live P&L
- Recent winners and losers
- Historical trends and summaries

### Manual Testing

**Development Mode (Localhost):**
- Use "Test Tracking" and "Test Summary" buttons in the dashboard
- No secret key required for localhost testing
- Real-time console logging available in debug mode

**Production/API Testing:**
```bash
# Test 5-minute tracking (requires secret key for manual calls)
curl -X POST "https://yoursite.com/api/trending/track?key=your-secret-key"

# Test 24-hour summary (requires secret key for manual calls)  
curl -X POST "https://yoursite.com/api/trending/summary?key=your-secret-key"

# View current stats (public endpoint)
curl "https://yoursite.com/api/trending/stats"

# Note: Vercel cron jobs call these endpoints without secret keys (auto-authenticated)
# Manual calls require the TRENDING_TRACKER_SECRET environment variable

# Test price updates via dashboard
# Click "Refresh Stats + Prices" button for manual price refresh
```

## 🔒 Security

- **API endpoints** protected with smart authentication system
- **Vercel cron jobs** automatically authenticated (no secret key needed)
- **Development mode** allows testing without secret key on localhost  
- **Manual calls** require secret key in production
- **Server-side only** secret key (not exposed to client-side)
- **Database policies** allow all operations (dev environment)
- **Rate limiting** handled by Jupiter API limits

## 📊 Expected Performance

### Tracking Capacity
- **Concurrent tokens**: 20-50 active at any time
- **Daily throughput**: 200-500 tokens processed
- **Storage per day**: ~1-2KB per token (~100KB daily)

### Win Rate Expectations
- **Typical range**: 30-70% depending on market conditions
- **Bull market**: Higher win rates (50-80%)
- **Bear market**: Lower win rates (20-50%)
- **Sideways market**: Moderate win rates (40-60%)

## 🛠️ Monitoring

### Health Checks
- Dashboard shows data freshness timestamps
- API errors logged in Vercel function logs
- Failed updates tracked in responses

### Troubleshooting
1. **No new tokens**: Check Jupiter API availability
2. **Stale data**: Verify Vercel cron job execution
3. **Database errors**: Check Supabase logs and connection
4. **Frontend issues**: Verify API endpoint responses

## 🔄 Price Update System

### Production (Automated)
- **Every 5 minutes**: Vercel Cron → `/api/trending/track` → Updates all tracked token prices
- **Database updates**: Prices, gain/loss calculations, status changes
- **Loss detection**: Automatic marking when tokens drop >50%

### Development & Manual Updates
- **"Refresh Stats + Prices" Button**: Fetches fresh prices via `/api/tokens/prices` route
- **Rate limiting protection**: 2-minute cache, smart batch processing
- **Real-time feedback**: Loading states and progress indicators
- **No secret key required**: Development mode allows localhost testing

### Price Update Sources
1. **Primary**: Jupiter API trending endpoint (full metadata)
2. **Secondary**: Jupiter price API (cached with rate limiting)
3. **Frontend**: Database-only refreshes (no external API calls)

## 🚀 Future Enhancements

### Potential Improvements
- **Multiple timeframes**: 6h, 12h tracking periods
- **Smart thresholds**: Dynamic loss thresholds based on volatility
- **Notifications**: Discord/Telegram alerts for big winners/losers
- **Backtesting**: Historical performance analysis
- **Portfolio simulation**: Track hypothetical investments
- **Advanced caching**: Redis integration for distributed caching

### Scaling Considerations
- **Database cleanup**: Automated removal of old tracking records
- **API rate limits**: Implement request queuing for high volume
- **Real-time updates**: WebSocket connections for live dashboard
- **Multi-exchange**: Support for additional DEX data sources

## 📋 Maintenance

### Database Cleanup
The system includes automatic cleanup functions:
- Completed tracking records (won/lost) are kept for 7 days
- Summary records are kept indefinitely for historical analysis
- Manual cleanup can be triggered via Supabase functions

### Monitoring Checklist
- [ ] Verify cron jobs are executing (check Vercel dashboard)
- [ ] Monitor database growth (Supabase usage tab) 
- [ ] Check API response times and error rates
- [ ] Review win rate trends for anomalies
- [ ] Validate token filtering criteria effectiveness

## 🎯 Success Metrics

### System Health
- **Uptime**: >99% API availability
- **Data freshness**: <5 minute delays
- **Processing speed**: <30s for 5-min updates

### Trading Performance
- **Win rate consistency**: Stable trends over time
- **Winner quality**: Average gains >20%
- **Loss mitigation**: Most losses caught at -50% threshold
- **Discovery efficiency**: New trending tokens added within 5 minutes 