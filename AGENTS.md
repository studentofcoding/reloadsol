# AGENTS.md

The process (orient → decide → build → verify → report) is user-global: see
`~/.commandcode/AGENTS.md`, full playbook in the `graphify-jev` skill.
This file holds **repo facts only**.

## Stack & layout

- Next.js 16 (App Router) + TypeScript, Postgres (`reloadsol_db`), Docker stack on `flowey-vps`.
- `src/app/` routes, `src/strategies/` strategy + ML spine, `src/components/`, `src/utils/`.
- `db/init/` numbered SQL migrations (00-…), applied by `scripts/init-local-db.sh`.
- `docs/specs/` — SPEC-before-implement handoffs; `docs/specs/README.md` is the index.
- `graphify-out/` — a knowledge graph of this repo.

## Orient

```bash
bash scripts/graphify-query-metered.sh "<question>"
```

Prints a `📉 Graphify before ~N after ~M saved X×` header, then the answer. Read
`graphify-out/GRAPH_REPORT.md` before broad greps. The graph auto-refreshes after writes/edits
via the global `PostToolUse` hook; run `graphify update .` yourself if it did not fire.

## Verify gate (exact)

```bash
rm -rf .next/ && npm run lint && npm run verify:no-raw-useeffect && npm run build && npm run start
```

Report each step verbosely (exit code + failures). Confirm `npm run start` boots, then stop it.

## Deploy chain

1. Push to `origin`.
2. `git pull` on `flowey-vps` — the post-merge hook rebuilds the docker stack.
3. Smoke-test the exact endpoints with the real Host header (`Host: reloadsol.app`); bare-IP
   curls are dropped by nginx (`default_server` → 444).

## Notes

- Command Code reads `AGENTS.md` (not `CLAUDE.md`).
- `.commandcode/` is gitignored here — local-only tooling; share process via this file.
- Learned preferences live in `.commandcode/taste/`.
