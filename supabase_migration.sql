-- Trading Records Table for PnL Tracking
-- Run this in your Supabase SQL Editor

-- Create the trading_records table
CREATE TABLE IF NOT EXISTS trading_records (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('buy', 'sell', 'close')),
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_trading_records_wallet 
  ON trading_records (wallet_address, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_trading_records_operation 
  ON trading_records (operation_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_trading_records_timestamp 
  ON trading_records (timestamp DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE trading_records ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to access only their own records
-- Since we don't have auth, we'll allow all operations for now
-- In production, you might want to restrict based on wallet address
CREATE POLICY "Allow all trading record operations" ON trading_records
  FOR ALL USING (true);

-- Enable real-time subscriptions for this table
ALTER PUBLICATION supabase_realtime ADD TABLE trading_records;

-- Optional: Create a function to clean up old records (older than 1 year)
CREATE OR REPLACE FUNCTION cleanup_old_trading_records()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM trading_records 
  WHERE timestamp < NOW() - INTERVAL '1 year';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Optional: Create a scheduled function to run cleanup weekly
-- Note: This requires the pg_cron extension which may not be available on free tier
-- SELECT cron.schedule('cleanup-old-trading-records', '0 2 * * 0', 'SELECT cleanup_old_trading_records();');

COMMENT ON TABLE trading_records IS 'Stores trading operation records for PnL tracking';
COMMENT ON COLUMN trading_records.data IS 'Complete tracking record as JSONB for flexibility';
COMMENT ON COLUMN trading_records.wallet_address IS 'Solana wallet address (base58 encoded)';
COMMENT ON COLUMN trading_records.operation_type IS 'Type of operation: buy, sell, or close';
COMMENT ON COLUMN trading_records.timestamp IS 'When the operation occurred';

-- Add PnL tracking columns to token_operations table
ALTER TABLE token_operations 
ADD COLUMN IF NOT EXISTS trade_pnl DECIMAL(15,6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_pnl_update TIMESTAMPTZ DEFAULT NOW();

-- Create index for PnL queries
CREATE INDEX IF NOT EXISTS idx_token_operations_pnl 
  ON token_operations (trade_pnl DESC, last_pnl_update DESC);

COMMENT ON COLUMN token_operations.trade_pnl IS 'Total trading profit/loss in USD';
COMMENT ON COLUMN token_operations.last_pnl_update IS 'When PnL was last calculated'; 