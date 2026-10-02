# SPEC — Remove the v2 entry ML heads (gate + potential) v1

**Status:** ~~to-spec~~ **WITHDRAWN (2026-10-01) — DO NOT EXECUTE.** Superseded by
[SPEC-ml-shadow-lane-v1.md](./SPEC-ml-shadow-lane-v1.md).
**Why withdrawn:** this SPEC concluded "neither head has ever loaded → dead → delete" from **env + artifact paths
only**. That test was incomplete. The lane is **wired, runs on live sim-open paths, and records**: `ml_exit_overlay_*`
is written on 2,493 rows. The heads' *artifacts* are genuinely absent, but the lane is the measurement half of a
measure-then-enforce design — the defect is that it is **starved and untuned**, not unused. The fix is to give it a
real signal, not to remove it. The impact map in §4 below is still useful as an inventory; treat §5–§6 as void.
**North star (unchanged):** the **rug label**.
**Why this doc exists:** "remove v2 gate/potential" turned out to touch ~35 files, one shared attach point, two live
sim-open paths and a product surface. This is the impact map and the safe execution order, so the context stops
living in chat.
**Related:** [SPEC-feature-registry-v1.md](./SPEC-feature-registry-v1.md) (P1, shipped), [SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) (P2, the reason the entry schema stays)

## 1. Goal

Delete the two **entry** ML heads — `gate` (ML1) and `potential` (ML2) — along with their runtime, their shadow
output, their config, and every mention, so the repo stops referencing them.

**Non-goals / explicitly KEEP:**
- The **entry feature schema** (registry `entry` stage; `ml/features.py` entry columns). It is the data contract
  P2 standardizes, and it is not the heads.
- The **pattern** head (`ML_PATTERN_*`, `entry-pattern-scorer*`, `PATTERN_FEATURE_KEYS`) — live.
- The **closed-loop** model (`ML_CLOSED_LOOP=1`) — live and acting.
- The `potential` **tracker label** (`rising`) and everything around it. Name collision only.

## 2. Evidence — why these are dead (measured on prod 2026-10-01)

| Head | Artifact | Env | Verdict |
|---|---|---|---|
| gate (ML1) | `/app/artifacts/v2-gate` **does not exist** | no `ML_GATE_*` at all | absent; `getMlGateMode()` defaults to `shadow`, and enforce additionally requires `metrics.gate_ready === true` |
| potential (ML2) | `ML_POTENTIAL_ARTIFACT_DIR=/ml/artifacts/v2-potential` — **path does not exist** (missing the `/app` prefix) | one line, host `.env:82`, injected into **web + cron** | absent; the ML2 overlay defaults to `shadow` (no `ML_POTENTIAL_EXIT_MODE`) |

Neither head has ever loaded. The only meta present anywhere is the **pattern** one (stale, 7 columns) — which is
the KEPT head. So removal changes nothing operationally; it removes dead weight and stops the config lying.

## 3. What the two heads actually are (so the map makes sense)

- **ML1 gate** — entry features → ONNX → `p_bad`; an *enforce* path can reject an entry. Shadow keys `ml_gate_*`.
- **ML2 potential** — entry features → 4-class tier; feeds **`potential-exit-overlay`** (tier / moonScore / pWinner →
  exit parameters, mode `off|shadow|apply`). Shadow keys `ml_potential_*`.
- Both are attached to entry features at sim open via **one shared function** (see §4.B) — the same function that
  attaches the *kept* pattern score.

## 4. Entanglement map

### A. Self-contained — safe to delete once nothing references them
| File | What it is |
|---|---|
| `src/strategies/entry-ml-scorer.ts` | pure scorer: `scoreBinaryGate`, `scorePotentialTier`, `MlModelMeta`, `getMlGateMode`, `getMlGatePBadMax`, `isGateModelReady`, `isPotentialModelReady`, `featureVectorToTensorInput` |
| `src/strategies/entry-ml-scorer.server.ts` | the artifact loader + `evaluateMlGateEnforce` |
| `src/strategies/entry-ml-scorer.test.ts` | its tests |
| `src/strategies/ml-shadow-log.ts` | writes the `ml_gate_*` / `ml_potential_*` keys |
| `src/strategies/potential-exit-overlay.ts` + `-config.ts` + `.test.ts` | the **ML2 exit overlay** (a product surface, not just a score) |
| `src/components/strategies/Ml2ExitOverlayPanel.tsx` | its admin panel |
| `src/app/api/strategies/ml/exit-overlay/route.ts` | its API route |

### B. SHARED with the kept pattern head — **strip, never delete**
| File | Why |
|---|---|
| `src/strategies/ml-entry-shadow.ts` | docstring: *"Attach **ML1 gate + ML2 potential + Pattern** shadow scores to entry features."* One attach point for both the removed heads **and** the kept pattern head. Deleting it kills the pattern shadow. |
| `src/strategies/ml-entry-shadow.test.ts` | mixes both |

`attachMlEntryShadow()` must shrink to pattern-only (`AttachMlEntryShadowResult` loses `gateReject`, `pBad`, …).

### C. Live call sites to strip (two are trading paths)
| File | Touches |
|---|---|
| `src/app/api/mcap-tracking/sim-track/route.ts` | scorer **+** shadow log **+** overlay (all three) |
| `src/app/api/signals/sim-track/route.ts` | overlay |
| `src/utils/mcap-sim-track.ts` | scorer / shadow |
| `src/strategies/trending-track/entry-features.ts` | overlay |
| `src/strategies/signals-early-alerts.ts` (+ `.test.ts`) | shadow fields |
| `src/strategies/outcome-features.ts` (+ `.test.ts`) | the `ml_gate_*` / `ml_potential_*` readers |
| `src/components/strategies/OutcomeReviewModal.tsx` | `OutcomeGateMlBadge` / `OutcomePotentialMlBadge` |
| `src/components/signals/SignalsTab.tsx` | shadow display |
| `src/components/strategies/StrategyAdminHub.tsx` | mounts `Ml2ExitOverlayPanel` |

**Behavioural note:** stripping these changes only what is *computed and logged* at sim open. Since both heads are
absent in prod, nothing that currently affects a decision changes.

### D. Config / deploy
- **VPS:** remove `ML_POTENTIAL_ARTIFACT_DIR` (host `.env` line 82) → recreate web **and** cron, verify.
- `.env.docker.example`, `docker-compose.yml`.
- `package.json`: the dead scripts `ml:train-gate`, `ml:train-potential`, `ml:check-dataset`, `ml:check-potential`.

### E. Docs needing a pass
`docs/ML_GATE_PLAN.md` (the whole plan doc), `docs/04-machine-learning.md`, `docs/deep_dive_ml.md`,
`docs/OPERATOR_STATE.md`, `docs/algo_overview.md`, `docs/03-strategies-and-automation.md`,
`docs/05-operations-and-deployment.md`, `docs/README.md`, `docs/ARCHITECTURE_SUMMARY.md`, `docs/architecture.md`,
`docs/STRATEGY_ARCHITECTURE.md`, `docs/reloadsol_engine_strategies_and_ml.md`,
`docs/SOLANA_DECISION_MACHINE_PLAN.md`, `ml/README.md`, `handoff.md`, `CHANGELOG.md`,
plus **this repo's newest docs**: `SPEC-feature-registry-v1.md`, `SPEC-strategy-data-pipeline-v1.md`, and
`docs/diagrams/14-strategy-data-pipeline.html` — which reference the heads and must be edited, not just deleted
around.

**Name collisions — do NOT touch** (they are not the heads): the `potential` tracker label
(`src/utils/tracker-label.ts`, `db/init/41-rename-tracking-label-rising.sql`,
`SPEC-potential-rug-labels-tracker-honesty-v1.md`), the pattern head's own files, and
`scripts/prebuild-strip-local-venvs.js`.

### F. The registry
The `entry` stage (`v1` 12 / `v2` 17) **stays** — it is the standardized data contract P2 builds on, not the heads.

## 5. Open decisions (blocking — answer before execution)

1. **ML2 exit overlay** — delete it with the head, or keep the overlay and re-point it at another signal
   (pattern `pWinner`? closed-loop `mlScore`?). It is currently driven by `ml_potential_*`.
2. **Offline entry track** — do `ml/train.py --stage gate|potential`, `ml/check_dataset.py`,
   `ml:export-entry-features` and `ml/data/v2/*` go too, or stay as the entry dataset toolchain?
   (The entry *schema* is kept either way.)
3. **`docs/ML_GATE_PLAN.md`** — delete outright, or mark superseded?

## 6. Execution order (strips first, deletes last)

The lesson from the aborted attempt: **do not delete a file to discover who used it.** Delete leaves only after
they are provably unreferenced.

| Step | Action | Verify |
|---|---|---|
| 0 | Answer the §5 decisions | — |
| 1 | Strip `ml-entry-shadow.ts` to pattern-only; fix its test | `npx vitest run src/strategies/ml-entry-shadow.test.ts` |
| 2 | Strip the §4.C call sites (mcap sim-track, signals sim-track, mcap-sim-track, trending entry-features, signals-early-alerts, outcome-features readers, the UI badges) | `npx tsc --noEmit` clean |
| 3 | Delete the now-unreferenced §4.A files | `npx tsc --noEmit` clean |
| 4 | Remove config: `.env.docker.example`, `docker-compose.yml`, npm scripts | `npm run lint` |
| 5 | VPS: back up `.env`, drop line 82, recreate web + cron, confirm the env no longer carries it | `docker exec … printenv` grep empty |
| 6 | Docs pass (§4.E), including the newest SPECs and the diagram page | grep for `ml_gate_` / `v2-potential` returns only intended hits |
| 7 | Full gate | `vitest run`, `lint`, `build`, `start` |

Each step is independently shippable, and step 1 + 2 deliberately precede any deletion.

## 7. Verification

- `npx tsc --noEmit` exit 0 after steps 1–3.
- `npx vitest run` green (the pattern + closed-loop + registry suites especially).
- Repo gate: `rm -rf .next/ && npm run lint && npm run verify:no-raw-useeffect && npm run verify:no-hardcoded-sol-price && npm run build && npm run start`.
- Grep guard: no `ml_gate_`, `ml_potential_`, `ML_GATE_`, or `v2-potential` outside intentional history
  (`CHANGELOG.md`).
- Prod: web + cron env free of `ML_POTENTIAL_ARTIFACT_DIR`; pattern head still loads/refuses as before;
  closed-loop unchanged.

## 8. Current state (baseline)

- **P1 is shipped** (registry + mirror + load-time refusal); `tsc` clean, 22/22 tests green in the touched suites.
- The attempted deletion was **reverted**: all 9 files restored from HEAD, and the P1 wiring re-applied to
  `entry-ml-scorer.ts` / `.server.ts` (they had carried uncommitted P1 edits, so the restore reverted those too —
  now re-applied and verified).
- **Nothing is deleted. Nothing is committed.** The VPS `.env` is untouched.
- Still pending from the same instruction: **P2** (canonical builder at the 11 writer sites) and the **VPS env line**.
