import { NextRequest } from 'next/server'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  const trackModule = await import('../track/route')
  return trackModule.GET(request)
} 