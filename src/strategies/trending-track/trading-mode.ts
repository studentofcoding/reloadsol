// Trading mode toggle extracted from src/app/api/trending/track/route.ts (REL-19).
import { query } from '@/utils/db'
import { TRACKER_TABLE } from './constants'
import type { TradingSimulation } from './types'

export async function setTradingMode(isSimulated: boolean, keypairPath?: string): Promise<void> {
  try {
    // Update all active simulations
    const { rows: activeSimulations } = await query<{ id: string; token_symbol: string | null; trading_simulation: TradingSimulation | null }>(
      `SELECT id, token_symbol, trading_simulation FROM ${TRACKER_TABLE}
       WHERE status = 'tracking' AND trading_simulation IS NOT NULL`,
    )

    // Update each simulation's trading mode
    for (const token of activeSimulations) {
      if (token.trading_simulation) {
        const simulation = token.trading_simulation as TradingSimulation
        simulation.is_simulated = isSimulated
        simulation.keypair_path = keypairPath

        try {
          await query(
            `UPDATE ${TRACKER_TABLE}
             SET trading_simulation = $1, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(simulation), token.id],
          )
          console.log(`✅ Updated trading mode for ${token.token_symbol}: ${isSimulated ? 'Simulated' : 'Real'} trading`)
        } catch (updateError) {
          console.error(`Failed to update trading mode for ${token.token_symbol}:`, updateError)
        }
      }
    }
  } catch (error) {
    console.error('Failed to set trading mode:', error)
    throw error
  }
}
