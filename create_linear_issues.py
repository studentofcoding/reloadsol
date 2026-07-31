#!/usr/bin/env python3
"""Create Linear issues from recommendations.md. Key passed via LINEAR_API_KEY env var."""
import json, os, sys, time, urllib.request

KEY = os.environ["LINEAR_API_KEY"]
TEAM = "a63200b2-bcd1-4810-8018-60354b9116bb"

L = {
    "phase-1": "5999eed3-dbdf-4ef4-a5a8-4b037dfc65c6",
    "phase-2": "1606783f-d880-43ee-9204-a42fc76cf9b8",
    "phase-3": "23daebda-2048-49c1-9a06-fb62bd5fa7c4",
    "rh-trading": "fdedf95f-0cce-403d-bba9-3b5121773449",
    "dlmm": "e8967a00-2c60-4cc2-9a67-f7266f1239cc",
    "ml": "998f1a77-46a6-4c7f-9b03-ff6320d807ea",
    "infra": "5112667e-ce3b-4532-a109-cccbb1612312",
    "security": "f077561a-7b6d-4814-8015-3fe89ac9309d",
    "strategies": "66de2e05-c674-4db8-abe9-f10ef44b1ee3",
}

SRC = "Source: recommendations.md (ReloadSOL infrastructure audit, commit 38610c8)"

def issue(ref, title, desc, priority, labels):
    return {"ref": ref, "title": title, "priority": priority,
            "labels": [L[x] for x in labels],
            "description": f"{desc}\n\n---\n*{SRC} · Audit item {ref}*"}

ISSUES = [
    # Audit area 1 — Solana vs Robinhood separation
    issue("1.1", "Introduce ChainLedger type with nativeAmount/nativePriceUsd at app layer",
          "RH sim trades write ETH values into Solana-shaped ledger fields `solAmount`, `solPriceUsd`, `totalSolBought` (`src/strategies/trending-bot-rh-sim.ts:162-202, 271-291`); `registry.ts:171-173` notes \"buy_amount_sol is unused on robinhood\". Rename semantic fields at the application layer (DB columns can stay); add typed mappers per chain in `trading-records-db.ts`.\n\n**Effort M · Impact Med**", 3, ["infra", "phase-2"]),
    issue("1.2", "Extract shared exit ladder into src/strategies/exit-ladder.ts",
          "`decideRhTrendingExit` (`trending-bot-rh-sim.ts:102-129`) is a fork of the Solana TP1/TP2/TP3/SL/max-hold ladder; two ladders will drift. Extract `decideTrendingExit(strategy, gainPct, heldHours, tp1Done)` and make both cycles call it; delete the fork.\n\n**Effort S · Impact Med**", 3, ["strategies", "phase-1"]),
    issue("1.3", "Move MAX_OPEN_POSITIONS and RH mcap bands into strategy_definitions.config",
          "RH hard-codes `MAX_OPEN_POSITIONS = 10` (`trending-bot-rh-sim.ts:25`) and registry-level `RH_MCAP_MIN/MAX` bands (`registry.ts:7-12`) — config drift vs the DB-overridable Solana params. Move into `strategy_definitions.config` so `/dev/strategies` can tune RH without a redeploy.\n\n**Effort S · Impact Med**", 3, ["strategies", "phase-1"]),
    issue("1.4", "Extend /dev/rpc-tester to probe RH RPC_4663 endpoints",
          "`/dev/rpc-tester` is sol-only (`route-network.ts:25`); there is no RH RPC health panel. Extend it (or add a small RH panel) to probe `RPC_4663` endpoints, reusing `checkProviderHealth`.\n\n**Effort S · Impact Med**", 3, ["infra", "rh-trading", "phase-2"]),
    issue("1.5", "Document the RH wallet model in docs/ARCHITECTURE_SUMMARY.md",
          "The parent-Rabby vs bound-GMGN wallet model currently lives only in a code comment (`src/utils/rh-wallet-mode.ts:6-10`). Document it in docs/ARCHITECTURE_SUMMARY.md.\n\n**Effort S · Impact Low**", 4, ["infra"]),

    # Audit area 2 — fast batch trading on Robinhood
    issue("2.1", "Deploy batch-executor multicall contract on Robinhood Chain (4663)",
          "Top-10 #1. RH bulk trades are `approve + swap` per leg flattened into `executeRhWalletCalls`, which only batches if the wallet supports EIP-5792 atomic — otherwise sequential `sendTransaction` + `waitForTransactionReceipt` per call (`src/utils/dlmm/rh-send-calls.ts:65-86`). A 10-token bulk buy can be ~21 sequential signed txs. Deploy a minimal audited multicall-style executor (owner-scoped, pull-based: transferFrom user → swap per leg → sweep); one signature executes wrap + approve + N swaps atomically. Keep `rh-send-calls.ts` as transport targeting the executor.\n\n**Effort M-L · Impact High**", 1, ["rh-trading", "phase-2"]),
    issue("2.2", "Replace per-trade approve txs on RH with Permit2 + one-time max allowances",
          "Top-10 #2. Permit2 (canonical `0x0000…8BA3`, `config.ts:7`) is already partially used in the v4 mint path (`src/utils/dlmm/rh-clmm/v4.ts:557-613`), but the Kyber swap path still does ERC20 `approve(router, maxUint256)` per token per router (`src/utils/dlmm/rh-kyber-swap.ts:133-152`). Approve each token once to Permit2; swaps/mints consume permit signatures or a one-time `permit2.approve(executor)`.\n\n**Effort S-M · Impact High**", 1, ["rh-trading", "phase-2"]),
    issue("2.3", "Parallelize Kyber route+build calls across legs",
          "Route+build is 2 sequential Kyber API calls per leg (`rh-kyber-swap.ts:89-99`, per-leg loop at `:209-231`) — 20 API calls for 10 tokens, latency-bound on Kyber. Fire all `/routes` calls concurrently (`Promise.all`), then builds concurrently; cache route summaries ~10s for repeat buys.\n\n**Effort S · Impact High**", 2, ["rh-trading", "phase-1"]),
    issue("2.4", "Evaluate ERC-4337 smart account + session keys for unattended RH execution",
          "Top-10 #3 (server execution path). `att_rh` is hard-coded `execution_mode: 'sim_only'` (`src/strategies/registry.ts:157-196`); all RH on-chain writes require a browser Rabby signature — no server signer for RH exists (only GMGN bound-wallet API signing, `src/strategies/gmgn-execution.ts:20-26`). Evaluate an ERC-4337 smart account with session keys scoped to (router, token allowlist, daily spend cap) as the clean path to unattended RH bots without a raw hot private key.\n\n**Effort L · Impact High**", 1, ["rh-trading", "phase-2"]),
    issue("2.5", "Track per-leg results in sequential RH batch fallback",
          "`executeRhParentKyberBuy` marks every leg `success: true` with the same batch hash (`rh-kyber-swap.ts:272-279`) even when executed sequentially; partial execution state is not tracked per leg. Record which leg index succeeded so partial buys are recoverable/reconcilable.\n\n**Effort S · Impact Med**", 3, ["rh-trading", "phase-1"]),
    issue("2.6", "Add nonce manager and maxFeePerGas strategy helper to RH client layer",
          "No nonce management or gas strategy exists in the RH client layer today — needed anyway for any future relayer/server signer.\n\n**Effort S · Impact Med**", 3, ["rh-trading"]),

    # Audit area 3 — DLMM/CLMM lifecycle
    issue("3.1", "Stand up RH CLMM automation worker (rh_clmm_manage, alert-only first)",
          "Top-10 #4. The Go cron binds 26 workers, all Solana-facing (`main.go:426-622`); zero scheduled automation for RH CLMM positions — fees only claimable by manual browser action (`claimV4Fees`, `v4.ts:1883-1957`). Add `rh_clmm_manage` in Go → `POST /api/dlmm/rh-clmm/manage`: batched StateView slot0 reads, in-range + unclaimed-fee computation, auto-claim above threshold, OOR timeout + TP/SL analogues, decisions written to `rh_clmm_positions`. Phase A (Phase 1): operator-alert-only Telegram mode. Phase B (Phase 2): active auto-claim/auto-close once a server signer exists (see 2.4).\n\n**Effort M · Impact High**", 2, ["dlmm", "phase-1", "phase-2"]),
    issue("3.2", "Multicall-aggregate getV4Position reads + Redis slot0 cache",
          "Top-10 #5. `listV4Positions` calls `getV4Position` sequentially, ~8 `readContract` calls + 2 price lookups per position (`v4.ts:1595-1603, 1418-1593`); discovery reverse-scans up to 300 tokenIds (`v4.ts:1333-1416`). A 20-position wallet is ~160+ RPC calls per refresh. Batch poolAndInfo/liquidity/slot0/fee-growth for all tokenIds into 1-2 multicall calls; add 15s Redis cache of pool slot0 per poolId.\n\n**Effort S · Impact Med**", 3, ["dlmm", "phase-1"]),
    issue("3.3", "Record poolKey in RH ledger at mint time",
          "`resolveV4PoolKey` brute-force fee/spacing loops (`v4.ts:185-234`) sit in the hot path although the poolKey is known at mint time. Record it in the RH ledger at mint.\n\n**Effort S · Impact Med**", 3, ["dlmm", "phase-1"]),
    issue("3.4", "Collapse 3x pool load in v4 mint to one load + one tick re-check",
          "Mint loads the pool 3× (`v4.ts:849, 936, 1012`) chasing tick freshness — each load is 4+ RPC calls. Collapse to one load + one tick re-check; pass deadline from caller.\n\n**Effort S · Impact Low**", 4, ["dlmm"]),
    issue("3.5", "Make Solana REDEPLOY real and add Meteora auto-fee-claim",
          "Top-10 #6. `manager.ts:172-178` records `last_decision='REDEPLOY'` and `executed=true` but never removes/re-adds liquidity; only the manual `editPosition` path redeploys (`actions.ts:137-157`). Also no auto-fee-claim exists for Meteora positions (fees only come out on remove). Implement REDEPLOY via remove + deploy with new bin range (reusing `editPosition`), or demote to an alert; add auto-fee-claim when claimableFees > threshold.\n\n**Effort S-M · Impact Med**", 3, ["dlmm", "phase-1"]),
    issue("3.6", "Batch fetchMeteoraPool calls in the Solana manage cycle",
          "The manage cycle is per-position HTTP+RPC serial: `fetchMeteoraPool` per position per 60s cycle (`manager.ts:135-154`) — fine at 5 positions, melts at 50. Fetch unique pools once per cycle and share across positions.\n\n**Effort S · Impact Med**", 3, ["dlmm", "phase-1"]),
    issue("3.7", "Map RH CLMM positions into unified algo-positions model",
          "RH ledger tracks tokenId/poolId (`rh-clmm-db.ts`) while Solana tracks position pubkey + bin ids (`dlmm/db.ts`); RH CLMM positions are not mapped into algo positions at all. Extend `algo-positions.ts` with `mapRhClmmPositionToAlgoPosition` so `/dev/strategies` shows RH LP alongside Meteora.\n\n**Effort S · Impact Med**", 3, ["dlmm", "phase-2"]),

    # Audit area 4 — strategy inventory
    issue("4.1", "Split 5,847-line trending/track monolith route into pure modules",
          "Top-10 #8 (precondition). `src/app/api/trending/track/route.ts` is 5,847 lines with dozens of inline sequential `await query(...)` / `insertTradingRecord` calls (e.g. lines 1690-1742, 3978-3980, 4241, 4553-4698); every 5-min cron tick runs this inside a Next.js request. Split into `src/strategies/trending-bot/{capture,calculate,result}.ts` pure modules + a thin route handler.\n\n**Effort L · Impact High**", 2, ["strategies", "phase-2"]),
    issue("4.2", "Batch DB writes per trending-bot cycle",
          "Per-token sequential `INSERT`/`UPDATE` in the trending route and sim cycles pay a PgBouncer round trip each; no batching, no `unnest`. Use one `INSERT ... SELECT`/`unnest` for records and tracker rows instead of per-token awaits.\n\n**Effort M · Impact High**", 2, ["strategies", "phase-2"]),
    issue("4.3", "Consolidate 12 load/merge strategy-config modules into loadDomainConfig(domain)",
          "The registry surface has `load-*.ts` × 6 + `merge-*.ts` × 6 = 12 near-identical modules around a large `Strategy Defaults Registry` community. Consolidate into one generic `loadDomainConfig(domain)` driven by a schema map.\n\n**Effort M · Impact Med**", 3, ["strategies"]),
    issue("4.4", "Fix O(n^2) RH sim cycle reconstruction in openPositionsFor",
          "`openPositionsFor` calls `computeOpenSimCycle(records, mint)` inside a loop over records — O(n²) over the wallet's record history (`trending-bot-rh-sim.ts:53-57`). Build cycles once per wallet fetch, index by mint.\n\n**Effort S · Impact Med**", 3, ["strategies", "phase-1"]),
    issue("4.5", "Rework mcap_tracker_sim_open 15s cadence to event-driven or 30-60s backoff",
          "`mcap_tracker_sim_open` runs every 15s (`algo_overview.md:238`) — a full HTTP→Next.js→DB cycle that mostly re-scans unchanged rows. Make it event-ish (only when new tracking rows appear) or back off to 30-60s.\n\n**Effort S · Impact Med**", 3, ["strategies"]),
    issue("4.6", "Archive or delete inactive scalper/hodl strategies",
          "`scalper` and `hodl` are shipped but inactive defaults; their configs still ship in every registry merge, enlarging the merge surface. Archive to docs or delete from the registry.\n\n**Effort S · Impact Low**", 4, ["strategies"]),

    # Audit area 5 — machine learning
    issue("5.1", "Expand ML winner cohort: 48-72h window, relaxed/ordinal labels",
          "Top-10 #7 (data problem, not tuning). Class-1 recall is 0 on holdout with {0:280, 1:50} training rows (handoff.md:13-24); label is coarse winner ≥120% / loser <80% with the neutral band dropped. Extend cohort window beyond 24h (48-72h relabel with `growth_at_24h` as a feature, not the label); relax winner to ≥100% or move to 3-class ordinal (loser/neutral/winner) to triple minority rows. Target ≥150 winners before any enforce discussion.\n\n**Effort M · Impact High**", 2, ["ml", "phase-3"]),
    issue("5.2", "Fix social feature coverage: snapshot rollups at entry time",
          "Social/wallet features have 0 importance (handoff.md:24) — likely constant-zero because most rows have no mentions in 30m (cold-start tokens); a coverage problem, not a model problem. Snapshot social rollups at entry time into `mcap_social_pattern_24h`; add lagged windows (mentions_5m, channels_1h, first-mention-source). Verify non-zero rate per feature in the export and log it in `model.meta.json` (logging part is Phase 1).\n\n**Effort M · Impact High**", 2, ["ml", "phase-1", "phase-3"]),
    issue("5.3", "Fix ML validation: tune threshold on valid split, report PR-AUC + class-1 recall",
          "Decision threshold is tuned on test proba (`ml/train_pattern.py:71-80`) — mild leakage inflating reported macro-F1; macro-F1 alone hides the recall-0 failure. Split train/valid/test by time; tune threshold on valid; report test once. Add PR-AUC and recall@precision≥0.5 to meta.\n\n**Effort S · Impact High**", 2, ["ml", "phase-1"]),
    issue("5.4", "Add probability calibration (isotonic/Platt) to pattern scorer",
          "`p_winner` is a raw LightGBM margin-prob; enforce thresholds will misbehave after retrains. Calibrate on the valid split (isotonic or Platt); store the calibrator in meta and apply it in the scorer.\n\n**Effort S-M · Impact Med**", 3, ["ml", "phase-3"]),
    issue("5.5", "Codify shadow-to-enforce criteria and scorer metrics logging",
          "Enforce criteria must be written down and enforced in code: require `pattern_ready` AND ≥150 class-1 train rows AND class-1 test recall ≥0.5 AND 2 weeks of shadow-vs-cohort agreement ≥ threshold. Add a scorer metric log (score latency, null-score rate — the reload-failure path currently returns null silently, `entry-pattern-scorer.server.ts:106-108`) to `cron_worker_runtime` or a small ML stats table.\n\n**Effort S · Impact High**", 2, ["ml", "phase-3"]),
    issue("5.6", "Automate daily retrain with artifact quality gate + Telegram report",
          "Retrain loop is manual + a daily cron script (`install-ml-pattern-cron.sh`, 03:00 UTC) with no automated quality gate blocking a bad artifact from being mounted. Extend the daily cron to run export→train→validate→only-replace-artifact-if-better (compare macro-F1 + class-1 recall vs current meta), then emit a Telegram summary.\n\n**Effort M · Impact Med**", 3, ["ml", "phase-3"]),
    issue("5.7", "Deduplicate TS/Python feature definitions into single source",
          "Feature pipelines are mirrored TS↔Py (`pattern-features.ts` ↔ `ml/pattern_features.py`); column parity is manual today. Generate the Python feature list from the TS canonical definition (or vice versa) so column order has a single source.\n\n**Effort S · Impact Med**", 3, ["ml"]),
    issue("5.8", "Precompute pattern scores in open-phase worker if enforce reaches live path",
          "Serving latency is fine as-is (cached in-process ONNX session, ~ms). If enforce ever moves to the live buy path, precompute scores in the open-phase worker (15s loop) rather than at click time.\n\n**Effort S · Impact Low**", 4, ["ml"]),

    # Audit area 6 — overall speed
    issue("6.2", "Move worker business logic out of Next.js request handlers",
          "Every Go cron tick pays Go→HTTP POST→Next.js route→DB (`main.go:426-622`; `algo_overview.md:222-226`), including framework + auth + cold-module costs. Move worker logic into shared modules called by both the route and (optionally) a direct Go→Postgres fast path; at minimum make Go call an internal non-nginx route with keep-alive.\n\n**Effort L · Impact High**", 2, ["infra", "phase-2"]),
    issue("6.3", "Batch per-cycle DB writes and add statement timing logs per worker cycle",
          "DB writes on the hot path are per-token sequential with no batching; add statement timing logs per worker cycle to find the worst offenders empirically (pairs with 4.2).\n\n**Effort M · Impact High**", 2, ["infra", "phase-2"]),
    issue("6.5", "Default Solana swaps to WebSocket confirmation, polling as fallback",
          "Raptor swap confirmation is prepare→sign→send→poll status per swap (`SWAP_AND_CLOSE_FLOW.md:17-24`); `confirmSignaturesViaWs` exists and is the right pattern. Make WS confirm the default; reserve Raptor status polling as fallback.\n\n**Effort S · Impact Med**", 3, ["infra"]),
    issue("6.6", "Hoist dynamic imports to module scope in trade-path handlers",
          "Module-level dynamic imports sit inside hot handlers (`entry-pattern-scorer.server.ts:27`, `actions.ts:101, 214-233` lazy `await import` of outcomes/snapshot modules per call) — per-request overhead in Next.js. Hoist to module scope.\n\n**Effort S · Impact Low**", 4, ["infra"]),

    # Top-10 #9 (not fully covered by numbered tables)
    issue("T9", "Replace default public RH RPC with dedicated/paid endpoint + failover",
          "Top-10 #9. RH defaults to a keyless public RPC `https://rpc.arrowrpc.com` (`src/utils/dlmm/rh-univ2.ts:11-19`). Replace with a dedicated/paid endpoint plus failover, and add the endpoint-health machinery the Solana side already has (`rpc-config.ts`, `checkProviderHealth`).\n\n**Impact Med · Effort S**", 3, ["infra", "rh-trading", "phase-2"]),

    # Bonus security note
    issue("SEC", "Add auth to Go cron /trigger/* endpoints",
          "Bonus security note. Go cron `/trigger/*` endpoints have no auth (docs/algo_overview.md:263; `main.go` registers them without middleware). They sit behind the Next.js proxy today, but the cron container port must never be exposed publicly. Add a shared-secret header check in Go (Phase 1 item 8).", 2, ["security", "phase-1"]),
]

# Skipped as cross-reference duplicates of numbered items:
SKIPPED = [
    ("6.1", "Batch executor + Permit2 on RH — pure cross-reference to 2.1/2.2"),
    ("6.4", "Multicall/batch RPC reads + Redis cache — pure cross-reference to 3.2"),
]

def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request("https://api.linear.app/graphql", data=body,
        headers={"Content-Type": "application/json", "Authorization": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

# Fetch existing titles to skip duplicates
res = gql('query { issues(filter: { team: { id: { eq: "%s" } } }, first: 100) { nodes { title identifier } } }' % TEAM)
existing = {n["title"].strip().lower() for n in res["data"]["issues"]["nodes"]}

MUT = """mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier title } }
}"""

created, skipped, failed = [], [], []
for it in ISSUES:
    if it["title"].strip().lower() in existing:
        skipped.append((it["ref"], it["title"]))
        continue
    inp = {"teamId": TEAM, "title": it["title"], "description": it["description"],
           "priority": it["priority"], "labelIds": it["labels"]}
    ok = False
    for attempt in (1, 2):
        try:
            r = gql(MUT, {"input": inp})
            if r.get("data", {}).get("issueCreate", {}).get("success"):
                iss = r["data"]["issueCreate"]["issue"]
                created.append((iss["identifier"], iss["title"]))
                ok = True
                break
            err = r.get("errors") or r
            if attempt == 2:
                failed.append((it["ref"], it["title"], json.dumps(err)[:300]))
        except Exception as e:
            if attempt == 2:
                failed.append((it["ref"], it["title"], str(e)[:300]))
        time.sleep(1.5)
    time.sleep(0.6)

print("=== CREATED (%d) ===" % len(created))
for ident, t in created:
    print(f"{ident}  {t}")
print("\n=== SKIPPED DUPLICATES (%d) ===" % len(skipped))
for ref, t in skipped:
    print(f"[{ref}] {t}")
print("\n=== SKIPPED CROSS-REFERENCE ITEMS ===")
for ref, note in SKIPPED:
    print(f"[{ref}] {note}")
print("\n=== FAILED (%d) ===" % len(failed))
for ref, t, e in failed:
    print(f"[{ref}] {t}: {e}")
