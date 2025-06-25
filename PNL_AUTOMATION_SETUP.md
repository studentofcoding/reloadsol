# Automated PnL Updates - Simple Setup

## 🎯 What This Does
Automatically calculates and updates each user's total trading PnL in the `token_operations` table every 24 hours.

## 🚀 Simple Setup (3 Steps)

### 1. Update Database Schema
Run the updated `supabase_migration.sql` in your Supabase SQL Editor:
```sql
-- This adds trade_pnl and last_pnl_update columns
ALTER TABLE token_operations 
ADD COLUMN IF NOT EXISTS trade_pnl DECIMAL(15,6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_pnl_update TIMESTAMPTZ DEFAULT NOW();
```

### 2. Set Environment Variable (Optional)
Add to your `.env.local`:
```bash
PNL_UPDATE_TOKEN=your-secret-token-here
```
*(If not set, defaults to `simple-pnl-token`)*

### 3. Deploy with Vercel Cron
The `vercel.json` file automatically schedules PnL updates at **2 AM daily**.

## ✅ Done! 
Your PnL will update automatically every 24 hours.

---

## 🧪 Manual Testing

### Test the API directly:
```bash
curl -X POST https://yoursite.com/api/pnl/update \
  -H "Authorization: Bearer simple-pnl-token" \
  -H "Content-Type: application/json"
```

### Or run the test script:
```bash
node scripts/update-pnl.js
```

---

## 📊 How It Works

### PnL Calculation Logic:
1. **Fetches** all trading records (last 30 days for performance)
2. **Groups** records by wallet address
3. **Calculates** PnL for each user:
   - Tracks buy prices for each token
   - Calculates profit/loss when tokens are sold
   - Sums total PnL across all trades
4. **Updates** `token_operations.trade_pnl` field

### Scheduling:
- **Vercel Cron**: Runs automatically at 2 AM daily
- **API Endpoint**: `/api/pnl/update` (POST with auth)
- **Manual Trigger**: Use the test script anytime

---

## 🔧 Configuration

### Schedule (vercel.json):
```json
{
  "crons": [
    {
      "path": "/api/pnl/update",
      "schedule": "0 2 * * *"  // 2 AM daily
    }
  ]
}
```

### Change Schedule:
- `0 2 * * *` = 2 AM daily
- `0 */6 * * *` = Every 6 hours  
- `0 0 * * 0` = Weekly on Sunday

### Authentication:
- Uses `PNL_UPDATE_TOKEN` environment variable
- Prevents unauthorized PnL updates
- Default: `simple-pnl-token`

---

## 📈 Results

### Database Updates:
Each user gets updated with:
- `trade_pnl`: Total profit/loss in USD
- `last_pnl_update`: When calculation was done

### API Response:
```json
{
  "success": true,
  "message": "Updated PnL for 15 wallets",
  "results": [
    {
      "wallet_address": "ABC123...",
      "total_pnl_usd": 45.67,
      "total_trades": 12,
      "successful_trades": 10,
      "success_rate": 83.33
    }
  ],
  "timestamp": "2024-01-15T02:00:00.000Z"
}
```

---

## 🚨 Troubleshooting

**Q: PnL not updating?**
- Check Vercel cron logs
- Test API endpoint manually
- Verify environment token

**Q: Wrong PnL calculations?**  
- PnL based on token buy/sell prices
- Only processes last 30 days for performance
- Requires price data in trading records

**Q: Performance issues?**
- Current: Processes 30 days of data
- Optimization: Reduce to 7 days if needed
- Runs at 2 AM for minimal impact

**Q: Want to change schedule?**
- Edit `vercel.json` schedule
- Redeploy to apply changes

---

## 🎉 Benefits

✅ **Automated** - No manual intervention needed  
✅ **Simple** - 3-step setup, works immediately  
✅ **Reliable** - Vercel cron handles scheduling  
✅ **Testable** - Manual trigger for immediate testing  
✅ **Secure** - Token-based authentication  
✅ **Efficient** - Only processes recent data  

Your users will have up-to-date PnL data every day! 📊 