#!/usr/bin/env node
/**
 * Next.js rewrites next-env.d.ts on dev/build (toggles .next/types vs .next/dev/types).
 * Restore a stable file; route types come from tsconfig includes.
 */
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'next-env.d.ts')
const contents = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Managed by scripts/lock-next-env.js — do not add .next/* imports (they flip between dev and build).
// Route types: see tsconfig.json ".next/types/**" and ".next/dev/types/**"
// https://nextjs.org/docs/app/api-reference/config/typescript
`

if (fs.existsSync(target)) {
  const current = fs.readFileSync(target, 'utf8')
  if (current === contents) return
}

fs.writeFileSync(target, contents)
console.log('[lock-next-env] restored stable next-env.d.ts')
