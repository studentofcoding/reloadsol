-- Fix trending_token_tracker status constraint to include 'waiting' status
-- This resolves the constraint violation error when inserting tokens with 'waiting' status

-- Drop the existing check constraint
ALTER TABLE trending_token_tracker 
DROP CONSTRAINT IF EXISTS trending_token_tracker_status_check;

-- Add the updated check constraint that includes 'waiting' status
ALTER TABLE trending_token_tracker 
ADD CONSTRAINT trending_token_tracker_status_check 
CHECK (status IN ('tracking', 'won', 'lost', 'waiting', 'skipped'));

-- Add columns for waiting system if they don't exist
ALTER TABLE trending_token_tracker 
ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ;

ALTER TABLE trending_token_tracker 
ADD COLUMN IF NOT EXISTS waiting_initial_price DECIMAL;

-- Create index for better performance on status queries
CREATE INDEX IF NOT EXISTS idx_trending_token_tracker_status 
ON trending_token_tracker (status);

-- Create index for waiting tokens
CREATE INDEX IF NOT EXISTS idx_trending_token_tracker_waiting 
ON trending_token_tracker (status, waiting_started_at) 
WHERE status = 'waiting';