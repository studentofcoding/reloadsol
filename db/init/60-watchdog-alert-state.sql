-- Cooldown state for the host-cron watchdogs.
--
-- Why a table and not a file: the watchdogs run on the host from crontab and must keep working while
-- the web app is down (one of them watches the web app's own exit worker). A file in $HOME survives
-- a container rebuild but not a host rebuild, and it is not visible to anything else. One row per
-- watchdog is enough — the only question is "when did we last shout".
--
-- Deliberately tiny and generic: `check-copier-freshness.sh` continues to use its own file-based
-- cooldown (it predates this and works); this is for watchers added from here on.

CREATE TABLE IF NOT EXISTS watchdog_alert_state (
  watchdog TEXT PRIMARY KEY,
  last_alert_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE watchdog_alert_state IS
  'Per-watchdog alert cooldown, so a long outage sends one message rather than one per tick.';
COMMENT ON COLUMN watchdog_alert_state.last_alert_at IS
  'When this watchdog last actually delivered an alert. A failed send must NOT update it, so the next tick retries.';
