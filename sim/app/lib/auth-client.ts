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

// Basic session interface matching what our YJS code expects
export interface Session {
  data?: {
    user?: {
      id: string;
      name?: string;
      email?: string;
    };
  };
}

// Cache for efficient session retrieval
let cachedSession: Session | null = null;
let cachedTimestamp: number = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Get the user session on the client side safely
 * This doesn't use React hooks and is safe for use in non-React contexts
 * @returns Current user session or null if not authenticated
 */
export async function getClientSession(): Promise<Session | null> {
  // Return cached session if still valid
  const now = Date.now();
  if (cachedSession && (now - cachedTimestamp < CACHE_TTL)) {
    return cachedSession;
  }

  try {
    // Try to get session from client (without using the hook)
    const clientSessionData = await client.getSession();
    
    // Convert better-auth session to our simplified Session format
    if (clientSessionData && clientSessionData.data?.user?.id) {
      const simplifiedSession: Session = {
        data: {
          user: {
            id: clientSessionData.data?.user?.id || '',
            name: clientSessionData.data?.user?.name || '',
            email: clientSessionData.data?.user?.email || ''
          }
        }
      };
      
      // Cache the session
      cachedSession = simplifiedSession;
      cachedTimestamp = now;
      return simplifiedSession;
    }

    // Fall back to API endpoint if client session not available
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      logger.warn('Failed to fetch session:', response.status);
      return null;
    }

    const session = await response.json();
    
    // Cache the session
    cachedSession = session;
    cachedTimestamp = now;
    return session;
  } catch (error) {
    logger.error('Error fetching session:', error);
    return null;
  }
}

/**
 * Clear the cached session
 * Call this when the user logs out or the session might have changed
 */
export function clearCachedSession(): void {
  cachedSession = null;
  cachedTimestamp = 0;
}
