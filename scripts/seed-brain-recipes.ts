#!/usr/bin/env npx tsx
/**
 * Idempotent upsert of known-winner lego recipes on market-brain.
 *
 * Requires MARKET_BRAIN_ADMIN_TOKEN (= brain BRAIN_ADMIN_TOKEN).
 *
 *   npx tsx scripts/seed-brain-recipes.ts
 *   npx tsx scripts/seed-brain-recipes.ts --dry-run
 *   npx tsx scripts/seed-brain-recipes.ts --deactivate=mcap_enter_at_80
 *   npx tsx scripts/seed-brain-recipes.ts --dormant=signals_sell_over_100
 *
 * Optional env: MARKET_BRAIN_URL (defaults to the live worker).
 */
import path from 'path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: path.resolve(__dirname, '../.env.local') })
loadEnv({ path: path.resolve(__dirname, '../.env') })

import {
  knownWinnerRecipes,
  seedKnownWinnerRecipes,
  syncLegoRecipe,
} from '../src/utils/brain-recipe-sync'
import { isMarketBrainAdminConfigured, marketBrainUrl } from '../src/utils/market-brain'

function argValue(prefix: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(prefix))
  if (!hit) return null
  const value = hit.slice(prefix.length)
  return value ? value : null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const deactivateId = argValue('--deactivate=')
  const dormantId = argValue('--dormant=')
  const activateId = argValue('--activate=')

  if (!isMarketBrainAdminConfigured() && !dryRun) {
    console.error(
      'MARKET_BRAIN_ADMIN_TOKEN is not set. Export it (brain BRAIN_ADMIN_TOKEN) and retry.',
    )
    process.exit(1)
  }

  console.log(`market-brain: ${marketBrainUrl()}`)

  if (dryRun) {
    const recipes = knownWinnerRecipes()
    console.log(`dry-run: would PUT ${recipes.length} recipes:`)
    for (const recipe of recipes) {
      console.log(
        `  ${recipe.id} domain=${recipe.domain} universe=${recipe.universe.join(',')} gates=${recipe.gates.map((g) => g.kind).join(',')}`,
      )
    }
    return
  }

  if (deactivateId) {
    const result = await syncLegoRecipe(deactivateId, 'deactivate')
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }
  if (dormantId) {
    const result = await syncLegoRecipe(dormantId, 'dormant')
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }
  if (activateId) {
    const result = await syncLegoRecipe(activateId, 'promote')
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }

  const result = await seedKnownWinnerRecipes()
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
