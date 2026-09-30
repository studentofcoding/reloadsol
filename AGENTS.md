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
rm -rf .next/ && npm run lint && npm run verify:no-raw-useeffect && npm run verify:no-hardcoded-sol-price && npm run build && npm run start
```

Report each step verbosely (exit code + failures). Confirm `npm run start` boots, then stop it.

## Deploy chain

1. Push to `origin`.
2. `git pull` on `flowey-vps` — the post-merge hook rebuilds the docker stack.
3. Smoke-test the exact endpoints with the real Host header (`Host: reloadsol.app`); bare-IP
   curls are dropped by nginx (`default_server` → 444).
4. The VPS is <4Gi and refuses host `next build` — ship web builds with
   `bash scripts/ship-standalone-to-vps.sh` from a machine with RAM. The shipped tree must be
   stamped with the VPS `HEAD` (`.next/{standalone,static}/.deploy-git-sha`) or the next deploy is
   forced to rebuild. **If `git status` shows uncommitted changes you did not make, do not ship
   from that tree** — `npm run build` would bake another workstream's in-flight code into prod.
   Build from an isolated worktree at the commit (recipe in `PRODUCTION_DEPLOYMENT.md`).
5. Migrations: `bash scripts/init-local-db.sh` applies `db/init/*.sql` idempotently, keeps going
   past a failing file, lists failures, and exits non-zero — so one bad file cannot silently skip
   the rest. `npm run db:check-migrations` applies the suite twice against a throwaway Postgres.

## Notes

- Command Code reads `AGENTS.md` (not `CLAUDE.md`).
- `.commandcode/` is gitignored here — local-only tooling; share process via this file.
- Learned preferences live in `.commandcode/taste/`.

## Several agents at once

This tree can be shared by more than one Command Code instance. Coordination is global and
automatic (the `agent-coordination` skill, hooks in `~/.commandcode/settings.json`); state lives
in `~/.commandcode/agents/<repo-slug>/`, never in the repo.

```bash
agents status            # who else is live here, their task/claims, foreign WIP
agents claim <path>…     # declare intent before a workstream; release when done
```

- **Never `git add -A` / `git commit -a` / `git stash` here** — commit explicit paths
  (`git add <paths>`, `git commit -- <paths>`). Foreign WIP means another agent is mid-flight.
- **Build/deploy from an isolated worktree at your own commit**, never from a tree carrying
  someone else's uncommitted work (this repo has already shipped a concurrent workstream's
  half-finished files once).

