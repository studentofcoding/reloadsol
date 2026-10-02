-- User-labelled rugs, counted per dev.
--
-- The rug label itself already lives in `token_rug_list` (one row per token+chain, written by
-- `markTokenRug` for every user surface: the Live-tab button, the Signals/Tracker/Board label
-- dropdowns, Freeview, /api/rug and the server actions). These columns are the per-dev roll-up: a
-- dev's reputation row gains the distinct tokens a *user* labelled as a rug, kept separate from the
-- automated GMGN aggregates (`sample` / `open_count` / `inner_count`) so "a user said rug" and "our
-- rules said rug" stay distinguishable.
--
-- `user_rug_tokens` is the source of truth for `user_rug_count` (deduped by token address, so a
-- re-mark cannot double count), mirroring how `tokens` holds the dev's top launches.
--
-- Display only for now: `scoreDevReputation` does not read either column.

ALTER TABLE dev_reputation
  ADD COLUMN IF NOT EXISTS user_rug_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE dev_reputation
  ADD COLUMN IF NOT EXISTS user_rug_tokens JSONB NOT NULL DEFAULT '[]'::jsonb;
