#!/usr/bin/env node
/**
 * Turbopack walks the repo when bundling entry-ml-scorer.server.ts and panics on
 * venv symlinks (python -> python3.x -> outside project root). Strip before build.
 * Recreate ML venv: cd ml && python3 -m venv venv && pip install -r requirements.txt
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
for (const rel of ['venv', 'ml/venv']) {
  const target = path.join(root, rel)
  if (!fs.existsSync(target)) continue
  fs.rmSync(target, { recursive: true, force: true })
  console.log(`[prebuild] removed ${rel} (venv symlinks break Turbopack; safe to recreate for ML)`)
}
