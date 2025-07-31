// Backward compatibility wrapper for existing logTradeOperation usage
import { log } from './unified-logger'

export function logTradeOperation(operation: string, data: any, error?: Error) {
  // Map old operation strings to new TradeOperationType
  const operationMap: Record<string, any> = {
    'Token Detection': 'token_detection',
    'Buy Execution': 'buy_execution',
    'Sell Execution': 'sell_execution',
    'Price Tracking': 'price_tracking',
    'Deviation Alert': 'deviation_alert',
    'Discord Notification': 'discord_notification',
    'Discord Status Check': 'discord_notification',
    'Discord New Token Detection': 'discord_notification',
    'Discord Buy Notification': 'discord_notification',
    'Discord Trade Alert': 'discord_notification',
    'Error Handling': 'error_handling'
  }

  const mappedOperation = operationMap[operation] || 'api_request'

  if (error) {
    log.error(mappedOperation, `${operation} failed`, error, data)
  } else {
    log.trade(mappedOperation, { ...data, operation })
  }
}

// Re-export everything from unified-logger for convenience
export * from './unified-logger'