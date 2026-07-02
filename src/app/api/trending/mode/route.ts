import { NextRequest } from 'next/server'

export async function PUT(request: NextRequest) {
  // Dynamically import to avoid pulling full track bundle into edge route
  const trackModule = await import('../track/route')
  return trackModule.PUT(request)
} 