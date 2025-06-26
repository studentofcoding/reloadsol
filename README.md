# Solana Bulk Token Buyer

A Next.js application for buying multiple Solana tokens in bulk with a single transaction flow. Built with TypeScript, Tailwind CSS, and the Solana Web3.js ecosystem.

## Features

### Core Trading Features
- 🚀 **Bulk Token Purchase**: Buy up to 10 different tokens in one transaction flow
- 💰 **Equal Distribution**: Automatically splits your SOL amount equally among selected tokens
- 🔗 **Jupiter Integration**: Uses Jupiter API for optimal swap routes and pricing
- 🎯 **Flexible Input**: Paste multiple mint addresses separated by lines, commas, or spaces
- ⚙️ **Customizable Settings**: Adjust slippage tolerance and priority fees
- 📱 **Responsive Design**: Works on desktop and mobile devices
- 🔐 **Wallet Integration**: Supports Phantom, Solflare, Torus, and Ledger wallets

### Analytics & Tracking
- 📊 **Trending Token Tracker**: Automated 24/7 monitoring of trending tokens with win/loss tracking
- 🎯 **Win Rate Analysis**: Track performance of trending tokens with automated summaries
- 🏆 **Leaderboards**: Top 5 performers identified every 24 hours
- 📈 **Real-time Dashboard**: Live P&L tracking for monitored tokens with manual price refresh
- 💰 **Enhanced Price Updates**: Smart caching system with rate limiting protection
- 🔧 **Debug Mode**: Comprehensive API testing and logging tools
- 🔔 **Discord Notifications**: Receive token updates and summaries in your Discord channel

## How It Works

1. **Connect Wallet**: Connect your Solana wallet (Phantom, Solflare, etc.)
2. **Enter SOL Amount**: Specify how much SOL you want to spend total
3. **Add Token Addresses**: Paste up to 10 token mint addresses
4. **Configure Settings**: Set slippage tolerance and priority fees
5. **Execute Purchase**: The app will:
   - Split your SOL equally among all tokens
   - Get quotes from Jupiter for each token
   - Create and sign all transactions
   - Execute purchases and show results

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd solana-bulk-buy
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables** (optional):
   ```bash
   cp .env.local.example .env.local
   # Edit .env.local with your preferred RPC URL
   ```

4. **Run the development server**:
   ```bash
   npm run dev
   ```

5. **Open your browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

### Basic Usage

1. Connect your Solana wallet
2. Enter the total SOL amount you want to spend (e.g., `0.1`)
3. Paste token mint addresses in the text area:
   ```
   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
   DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
   ```
4. Click "Buy X Tokens" to execute the purchase

### Advanced Settings

- **Slippage Tolerance**: How much price movement you're willing to accept (0.1% - 5%)
- **Priority Fee**: Additional fee to prioritize your transactions (None - High)

### Input Formats

The app accepts mint addresses in multiple formats:
- One per line
- Comma-separated
- Space-separated
- Mixed formats

Example:
```
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 So11111111111111111111111111111111111111112
```

## Technical Details

### Architecture

- **Frontend**: Next.js 14 with App Router
- **Styling**: Tailwind CSS
- **Wallet Integration**: Solana Wallet Adapter
- **Swap API**: Jupiter Aggregator
- **Blockchain**: Solana Web3.js

### Key Components

- `BulkTokenBuyer`: Main component handling the purchase flow
- `WalletProvider`: Solana wallet connection provider
- `jupiter.ts`: Jupiter API integration utilities
- `solana.ts`: Solana connection and configuration

### Transaction Flow

1. **Quote Phase**: Get swap quotes for each token from Jupiter
2. **Transaction Creation**: Create versioned transactions for each swap
3. **Signing**: Sign all transactions using wallet adapter
4. **Execution**: Send transactions to Solana network
5. **Confirmation**: Wait for transaction confirmations and display results

## Configuration

### Environment Variables

- `NEXT_PUBLIC_RPC_URL`: Custom Solana RPC endpoint (optional)
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for token update notifications
- `ENABLE_DISCORD_NOTIFICATIONS`: Set to 'true' to enable Discord notifications
- `TRENDING_TRACKER_SECRET`: Secret key for trending tracker API endpoints (optional)

### Discord Integration

The application can send token updates to a Discord channel using webhooks:

1. **Create a Discord webhook**:
   - In Discord, go to Server Settings > Integrations > Webhooks
   - Click "New Webhook", give it a name and select a channel
   - Copy the webhook URL

2. **Configure environment variables**:
   ```bash
   # Add these to your .env.local file
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-id/your-webhook-token
   ENABLE_DISCORD_NOTIFICATIONS=true
   ```

3. **Notification Content**:
   - Token updates (added, updated, removed)
   - Price movements
   - Top 5 tokens by organic score
   - Summary statistics

### Default Settings

- **Network**: Mainnet Beta
- **Slippage**: 1%
- **Priority Fee**: 0.0001 SOL
- **Max Tokens**: 10 per transaction

## Security Considerations

- Always verify token mint addresses before purchasing
- Start with small amounts when testing
- Be aware of slippage on low-liquidity tokens
- Check transaction signatures on Solscan after execution

## Troubleshooting

### Common Issues

1. **"Insufficient balance"**: Ensure you have enough SOL for purchases + fees
2. **"No valid quotes"**: Some tokens may not have liquidity on Jupiter
3. **"Transaction failed"**: Network congestion or slippage exceeded
4. **"Invalid mint address"**: Check that addresses are valid Solana token mints

### Getting Help

- Check the browser console for detailed error messages
- Verify transactions on [Solscan](https://solscan.io)
- Ensure your wallet is connected to Mainnet

## Trending Token Tracker

### Overview
The Trending Token Tracker is an automated system that monitors trending tokens from Jupiter API, tracks their price performance over 24-hour periods, and generates comprehensive win/loss statistics.

### Key Features
- **5-minute price updates**: Automatic tracking of token prices every 5 minutes
- **Manual price refresh**: "Refresh Stats + Prices" button for on-demand updates
- **Smart caching**: Rate-limited price API with 2-minute cache and batch processing
- **Loss detection**: Tokens dropping >50% are automatically marked as "lost"
- **Winner identification**: Top 5 performers each 24 hours are marked as "won"
- **Win rate calculation**: `wins / (wins + losses) * 100`
- **Real-time dashboard**: Live monitoring at `/dev/trending-tracker`
- **Debug tools**: Testing buttons and detailed console logging

### Quick Setup
1. **Database Setup**: Run `trending_tracker_migration.sql` in Supabase SQL Editor
2. **Deploy**: System runs automatically via Vercel cron jobs
3. **Access Dashboard**: Navigate to `/dev/trending-tracker`

### API Endpoints
- `/api/trending/track` - 5-minute price updates (automated)
- `/api/trending/summary` - 24-hour summaries (automated)
- `/api/trending/stats` - Frontend data source (public)

### Manual Testing
```bash
node scripts/test-trending-tracker.js all
```

For complete setup instructions, see [TRENDING_TRACKER_SETUP.md](./TRENDING_TRACKER_SETUP.md).

## Development

### Project Structure

```
src/
├── app/                 # Next.js app router
│   ├── api/trending/    # Trending tracker APIs
│   └── dev/             # Development tools & dashboards
├── components/          # React components
├── types/              # TypeScript type definitions
├── utils/              # Utility functions
└── hooks/              # Custom React hooks (future)
```

### Building for Production

```bash
npm run build
npm start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Disclaimer

This software is provided as-is. Always verify transactions and use at your own risk. The developers are not responsible for any financial losses.