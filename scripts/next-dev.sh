#!/bin/sh
# Re-lock next-env.d.ts when dev server stops (Next toggles routes import path).
trap 'node scripts/lock-next-env.js' EXIT INT TERM
exec next dev "$@"
