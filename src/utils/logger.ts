export function logTradeOperation(operation: string, data: any, error?: Error) {
  const timestamp = new Date().toISOString()
  const logData = {
    timestamp,
    operation,
    ...data,
    error: error ? {
      message: error.message,
      stack: error.stack
    } : undefined
  }
  console.log(`[${timestamp}] ${operation}:`, JSON.stringify(logData, null, 2))
} 