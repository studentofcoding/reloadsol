// Strategy buy-amount / priority-fee resolution extracted from src/app/api/trending/track/route.ts (REL-19).
import { resolveTradingStrategy } from '@/strategies/load-strategy'

export function getBuyAmountForStrategy(strategyId?: string): number {
  // Check for global environment override first
  const envBuyAmount = process.env.BUY_AMOUNT_SOL
  if (envBuyAmount) {
    const amount = parseFloat(envBuyAmount)
    if (!isNaN(amount) && amount > 0 && amount <= 1.0) { // Max 1 SOL safety limit
      console.log(`💰 Using environment override BUY_AMOUNT_SOL: ${amount} SOL`)
      return amount
    } else {
      console.warn(`⚠️ Invalid BUY_AMOUNT_SOL environment value: ${envBuyAmount}, using strategy default`)
    }
  }

  // Check for strategy-specific environment override
  if (strategyId) {
    const strategyEnvKey = `BUY_AMOUNT_SOL_${strategyId.toUpperCase()}`
    const strategyEnvAmount = process.env[strategyEnvKey]
    if (strategyEnvAmount) {
      const amount = parseFloat(strategyEnvAmount)
      if (!isNaN(amount) && amount > 0 && amount <= 1.0) {
        console.log(`💰 Using strategy-specific override ${strategyEnvKey}: ${amount} SOL`)
        return amount
      } else {
        console.warn(`⚠️ Invalid ${strategyEnvKey} environment value: ${strategyEnvAmount}, using strategy default`)
      }
    }
  }

  // Use strategy-specific buy amount
  const strategy = resolveTradingStrategy(strategyId)
  console.log(`💰 Using ${strategy.name} buy amount: ${strategy.buy_amount_sol} SOL`)
  return strategy.buy_amount_sol
}

// Helper function to get priority fee for strategy with environment override
export function getPriorityFeeForStrategy(strategyId?: string): number {
  // Check for global environment override first
  const envPriorityFee = process.env.PRIORITY_FEE_LAMPORTS
  if (envPriorityFee) {
    const fee = parseInt(envPriorityFee)
    if (!isNaN(fee) && fee >= 0 && fee <= 1000000) { // Max 0.001 SOL safety limit
      console.log(`⚡ Using environment override PRIORITY_FEE_LAMPORTS: ${fee} lamports`)
      return fee
    } else {
      console.warn(`⚠️ Invalid PRIORITY_FEE_LAMPORTS environment value: ${envPriorityFee}, using strategy default`)
    }
  }

  // Check for strategy-specific environment override
  if (strategyId) {
    const strategyEnvKey = `PRIORITY_FEE_LAMPORTS_${strategyId.toUpperCase()}`
    const strategyEnvFee = process.env[strategyEnvKey]
    if (strategyEnvFee) {
      const fee = parseInt(strategyEnvFee)
      if (!isNaN(fee) && fee >= 0 && fee <= 1000000) {
        console.log(`⚡ Using strategy-specific override ${strategyEnvKey}: ${fee} lamports`)
        return fee
      } else {
        console.warn(`⚠️ Invalid ${strategyEnvKey} environment value: ${strategyEnvFee}, using strategy default`)
      }
    }
  }

  // Use strategy-specific priority fee
  const strategy = resolveTradingStrategy(strategyId)
  console.log(`⚡ Using ${strategy.name} priority fee: ${strategy.priority_fee_lamports} lamports`)
  return strategy.priority_fee_lamports
}
