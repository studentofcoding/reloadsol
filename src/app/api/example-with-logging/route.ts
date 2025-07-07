import { NextRequest, NextResponse } from 'next/server'
import { withApiLogging, ApiLogger } from '@/utils/api-logger'

// Example API route with integrated logging
export const GET = withApiLogging(async (request: NextRequest, logger: ApiLogger) => {
  const { searchParams } = new URL(request.url)
  const delay = parseInt(searchParams.get('delay') || '0')
  const shouldError = searchParams.get('error') === 'true'

  // Log request details
  logger.info('Processing example request', {
    delay,
    shouldError,
    userAgent: request.headers.get('user-agent')
  })

  // Simulate some work
  if (delay > 0) {
    logger.debug(`Simulating ${delay}ms delay`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  // Simulate an error condition
  if (shouldError) {
    const error = new Error('Simulated error for testing')
    logger.error('Simulated error occurred', error, {
      errorType: 'simulated',
      requestParams: { delay, shouldError }
    })
    
    return NextResponse.json(
      { error: 'Simulated error', timestamp: new Date().toISOString() },
      { status: 500 }
    )
  }

  // Success response
  logger.info('Request completed successfully', {
    responseData: 'example_data',
    processingTime: delay
  })

  return NextResponse.json({
    success: true,
    message: 'Example API response',
    timestamp: new Date().toISOString(),
    requestId: logger.getRequestId(),
    delay
  })
})

// Example POST handler
export const POST = withApiLogging(async (request: NextRequest, logger: ApiLogger) => {
  try {
    const body = await request.json()
    
    logger.info('POST request received', {
      bodyKeys: Object.keys(body),
      contentLength: request.headers.get('content-length')
    })

    // Validate required fields
    if (!body.data) {
      logger.warn('Missing required field: data')
      return NextResponse.json(
        { error: 'Missing required field: data' },
        { status: 400 }
      )
    }

    // Process the data
    logger.debug('Processing POST data', { dataType: typeof body.data })
    
    // Simulate processing
    await new Promise(resolve => setTimeout(resolve, 100))

    logger.info('POST request processed successfully')

    return NextResponse.json({
      success: true,
      message: 'Data processed successfully',
      requestId: logger.getRequestId(),
      processedData: body.data
    })

  } catch (error) {
    logger.error('POST request failed', error as Error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}) 