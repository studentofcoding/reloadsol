-- Radar daily digest pin state (optional; also ensured at runtime)
CREATE TABLE IF NOT EXISTS radar_digest_pins (
  chat_id TEXT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
