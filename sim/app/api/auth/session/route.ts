import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console-logger'

const logger = createLogger('Auth Session API')

export async function GET() {
  try {
    // Get the session using the server-side auth function
    const session = await getSession()
    
    // Return the session data or null
    return NextResponse.json(session || { user: null })
  } catch (error) {
    logger.error('Error fetching session:', error)
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500 }
    )
  }
} 