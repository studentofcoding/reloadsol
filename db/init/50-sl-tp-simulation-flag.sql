-- Paper positions in the SL/TP tracker.
--
-- Why this is needed before anything writes a simulated position into sl_tp_positions: the monitor
-- triggers `executeSellOrder`, which runs a REAL swap (it hardcodes isSimulated: false), and
-- `reconcileClosedPositions` prunes any position whose wallet balance reads zero — which is every
-- simulated position, since paper tokens never exist on-chain. Without a simulation flag the tracker
-- would sell real tokens for a paper stop-loss, or silently drop the paper position on the first
-- reconcile pass. The flag is what makes both paths behave.

ALTER TABLE sl_tp_positions
  ADD COLUMN IF NOT EXISTS is_simulation BOOLEAN NOT NULL DEFAULT false;

-- The monitor reads by activity; simulated rows are looked up the same way.
CREATE INDEX IF NOT EXISTS idx_sl_tp_positions_simulated
  ON sl_tp_positions (is_simulation, is_active)
  WHERE is_active;

COMMENT ON COLUMN sl_tp_positions.is_simulation IS
  'Paper position: the monitor records triggers but never touches the chain (see shouldExecuteOnChain).';
