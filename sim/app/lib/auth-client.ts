'use client'

import { createLogger } from '@/lib/logs/console-logger'
import { emailOTPClient, genericOAuthClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

const logger = createLogger('Auth Client')

// Create the client using better-auth/react client-side APIs
export const client = createAuthClient({
  plugins: [
    genericOAuthClient(), 
    emailOTPClient()
  ]
})

// Export hooks and methods that match server-side auth API
export const { useSession, signIn, signUp, signOut } = client
