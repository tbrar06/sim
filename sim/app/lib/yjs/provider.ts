'use client'

import { createLogger } from '@/lib/logs/console-logger'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { useSession } from '@/lib/auth-client'

const logger = createLogger('YJS Provider')

// Singleton instance
let provider: WorkflowYjsProvider | null = null

export class WorkflowYjsProvider {
  private doc: Y.Doc
  private wsProvider: WebsocketProvider | null = null
  private isConnected = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private userId: string | null = null
  private isDestroyed = false

  private constructor() {
    this.doc = new Y.Doc()
  }

  static getInstance(): WorkflowYjsProvider {
    if (!provider) {
      provider = new WorkflowYjsProvider()
    }
    return provider
  }

  async connect(): Promise<void> {
    if (this.isConnected || this.isDestroyed) return

    try {
      const session = await useSession()
      if (!session?.data?.user?.id) {
        throw new Error('User not authenticated')
      }

      this.userId = session.data.user.id
      
      // Use a consistent document name for the user to ensure all tabs share the same state
      const roomName = `user-${session.data.user.id}`
      
      // Disconnect existing provider if it exists
      if (this.wsProvider) {
        this.wsProvider.destroy()
        this.wsProvider = null
      }

      // Connect to WebSocket server with user-specific room
      this.wsProvider = new WebsocketProvider(
        process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:1234',
        roomName,
        this.doc,
        { connect: true }
      )

      // Set awareness information if available
      if (session.data.user.name) {
        this.wsProvider.awareness.setLocalStateField('user', {
          id: session.data.user.id,
          name: session.data.user.name,
          color: this.getRandomColor(),
        })
      }

      this.wsProvider.on('status', ({ status }: { status: string }) => {
        const wasConnected = this.isConnected
        this.isConnected = status === 'connected'
        
        if (this.isConnected && !wasConnected) {
          this.reconnectAttempts = 0
          logger.info(`YJS WebSocket connected to room: ${roomName}`)
        } else if (!this.isConnected && wasConnected) {
          logger.warn('YJS WebSocket disconnected')
        }
      })

      this.wsProvider.on('connection-error', (event: Event) => {
        logger.error('YJS WebSocket connection error:', event)
        this.handleReconnect()
      })

      // Wait for connection to establish
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 5000)

        const statusHandler = ({ status }: { status: string }) => {
          if (status === 'connected') {
            clearTimeout(timeout)
            this.wsProvider?.off('status', statusHandler)
            resolve()
          }
        }

        // Already connected
        if (this.wsProvider?.wsconnected) {
          clearTimeout(timeout)
          resolve()
          return
        }

        this.wsProvider?.on('status', statusHandler)
      })
    } catch (error) {
      logger.error('Failed to connect to YJS:', error)
      this.handleReconnect()
      throw error
    }
  }

  private handleReconnect(): void {
    if (this.isDestroyed || this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached or provider destroyed')
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    
    setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect().catch(error => {
          logger.error('Reconnection failed:', error)
        })
      }
    }, delay)
  }

  private getRandomColor(): string {
    const colors = ['#2D9CDB', '#F2994A', '#6FCF97', '#BB6BD9', '#EB5757', '#9B51E0', '#219653']
    return colors[Math.floor(Math.random() * colors.length)]
  }

  getDoc(): Y.Doc {
    return this.doc
  }

  getUserId(): string | null {
    return this.userId
  }

  isConnectedToServer(): boolean {
    return this.isConnected && !!this.wsProvider?.wsconnected
  }

  disconnect(): void {
    this.isDestroyed = true
    if (this.wsProvider) {
      this.wsProvider.destroy()
      this.wsProvider = null
      this.isConnected = false
    }
  }
} 