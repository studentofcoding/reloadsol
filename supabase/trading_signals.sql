-- Create a new table for trading signals
create table if not exists public.trading_signals (
  id uuid default gen_random_uuid() primary key,
  token_address text not null unique,
  token_symbol text,
  label text check (label in ('watching', 'potential', 'rugged')),
  
  -- Market Data for Weighting
  market_cap numeric default 0,
  price numeric default 0,
  
  -- Tracking Results
  initial_price numeric default 0,
  result jsonb,
  image_reference text,
  
  -- Metadata
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  
  -- Optional: Track who added it (if auth is enabled)
  user_wallet text
);

-- Add indexes
create index if not exists trading_signals_token_address_idx on public.trading_signals (token_address);
create index if not exists trading_signals_label_idx on public.trading_signals (label);

-- Enable RLS (Optional, depending on your setup, currently public access seems implied by code)
alter table public.trading_signals enable row level security;

create policy "Allow public read access" on public.trading_signals for select using (true);
create policy "Allow public insert access" on public.trading_signals for insert with check (true);
create policy "Allow public update access" on public.trading_signals for update using (true);
create policy "Allow public delete access" on public.trading_signals for delete using (true);
