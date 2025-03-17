'use client'

import { createLogger } from '@/lib/logs/console-logger'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { getClientSession } from '@/lib/auth-client'

const logger = createLogger('YJS Provider')

// Singleton instance per workflow
const providers = new Map<string, WorkflowYjsProvider>()

export class WorkflowYjsProvider {
  private doc: Y.Doc
  private wsProvider: WebsocketProvider | null = null
  private isConnected = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private userId: string | null = null
  private workflowId: string | null = null
  private isDestroyed = false
  private connectionPromise: Promise<void> | null = null

  private constructor(workflowId: string) {
    this.doc = new Y.Doc()
    this.workflowId = workflowId
  }

  static getInstance(workflowId?: string): WorkflowYjsProvider {
    if (!workflowId) {
      throw new Error('WorkflowId is required to get a YJS provider instance')
    }
    
    if (!providers.has(workflowId)) {
      providers.set(workflowId, new WorkflowYjsProvider(workflowId))
    }
    
    return providers.get(workflowId)!
  }

  static cleanup(workflowId?: string): void {
    if (workflowId) {
      // Clean up specific provider
      const provider = providers.get(workflowId)
      if (provider) {
        provider.disconnect()
        providers.delete(workflowId)
      }
    } else {
      // Clean up all providers
      providers.forEach(provider => provider.disconnect())
      providers.clear()
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected || this.isDestroyed) return
    
    // If already connecting, return the existing promise
    if (this.connectionPromise) {
      return this.connectionPromise
    }

    // Create a new connection promise
    this.connectionPromise = this._connect()
    return this.connectionPromise
  }

  private async _connect(): Promise<void> {
    try {
      // Use getClientSession instead of useSession to avoid React hooks in non-React contexts
      const session = await getClientSession()
      if (!session?.data?.user?.id) {
        throw new Error('User not authenticated')
      }

      this.userId = session.data.user.id
      
      // Use workflow-specific room name for collaboration
      const roomName = `workflow-${this.workflowId}`
      
      // Disconnect existing provider if it exists
      if (this.wsProvider) {
        this.wsProvider.destroy()
        this.wsProvider = null
      }

      // Connect to WebSocket server with workflow-specific room
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
      
      // Reset connection promise once completed
      this.connectionPromise = null
    } catch (error) {
      logger.error('Failed to connect to YJS:', error)
      this.handleReconnect()
      // Reset connection promise on error
      this.connectionPromise = null
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

  getWorkflowId(): string | null {
    return this.workflowId
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