#!/usr/bin/env bash
# Build a postgres URL with URL-encoded password (safe for @ # : in passwords).
set -euo pipefail

node -e "
const user = process.env.PGUSER || 'postgres';
const pass = encodeURIComponent(process.env.PGPASSWORD || '');
const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
const db = process.env.PGDATABASE || 'reloadsol_db';
process.stdout.write('postgresql://' + user + ':' + pass + '@' + host + ':' + port + '/' + db);
"
