import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const trackModule = await import('../track/route')
  return trackModule.GET(request)
} 