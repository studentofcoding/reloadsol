#!/usr/bin/env bash
# Validate postgres URL parses cleanly (catches @ in password, hostname in password field, etc.).
set -euo pipefail

URL="${1:?usage: validate-database-url.sh postgresql://...}"
LABEL="${2:-database URL}"

node -e "
const url = process.argv[1];
const label = process.argv[2];
const normalized = url.replace(/^postgresql:\\/\\//, 'postgres://');
let u;
try {
  u = new URL(normalized);
} catch (e) {
  console.error('[validate-database-url] Invalid ' + label + ': ' + e.message);
  console.error('  If password contains @ # : / use URL encoding or build-database-url.sh');
  process.exit(1);
}
const port = u.port || '5432';
if (!/^\\d+\$/.test(port)) {
  console.error('[validate-database-url] Invalid ' + label + ' — port parsed as: ' + JSON.stringify(port));
  console.error('  Usually caused by @ in password without encoding, or hostname pasted into password.');
  console.error('  Supabase direct format:');
  console.error('    postgresql://postgres.[ref]:YOUR_PASSWORD@db.[ref].supabase.co:5432/postgres');
  console.error('  Local target: let deploy-tencent.sh migrate build TARGET from .env (do not export TARGET manually).');
  process.exit(1);
}
if (!u.hostname) {
  console.error('[validate-database-url] Missing hostname in ' + label);
  process.exit(1);
}
const pass = decodeURIComponent(u.password || '');
if (pass.includes('.supabase.co')) {
  console.error('[validate-database-url] ' + label + ' password looks like a hostname — use only your DB password.');
  process.exit(1);
}
" "$URL" "$LABEL"
