/**
 * YJS Collaboration Utilities
 * 
 * Utilities for setting up YJS with Redis persistence and WebSocket connections.
 * These functions handle the initialization of Redis persistence providers and
 * WebSocket connection setup for YJS.
 */

import { setupWSConnection } from 'y-websocket/bin/utils';
import { createClient } from 'redis';
import { URL } from 'url';

// Storage for documents in memory with room-specific persistence
const documents = new Map();

// Keep track of connected users per room for presence awareness
const roomConnections = new Map();

/**
 * Creates a Redis persistence provider for YJS
 * 
 * @param {string} redisUrl - Redis connection URL
 * @param {string} prefix - Redis key prefix for YJS documents
 * @returns {Promise<Object>} - Persistence provider with bind and writeState methods
 */
export async function createRedisPersistence(redisUrl, prefix) {
  try {
    // Initialize Redis client
    const redisClient = createClient({
      url: redisUrl
    });

    // Register Redis error handler
    redisClient.on('error', (err) => {
      console.error('Redis client error:', err);
    });

    // Create a persistence provider
    const persistence = {
      // Binding a document - load initial state
      bindState: async (docName, ydoc) => {
        console.log(`Binding document: ${docName}`);
        
        try {
          // Check if document already exists in memory
          const existing = documents.get(docName);
          if (existing) {
            Y.applyUpdate(ydoc, existing);
            console.log(`Loaded document ${docName} from memory`);
            return;
          }
          
          // Try to load from Redis if connected
          if (redisClient.isOpen) {
            const key = `${prefix}${docName}`;
            const storedDoc = await redisClient.get(key);
            
            if (storedDoc) {
              // Apply the stored state to the document
              const docBuffer = Buffer.from(storedDoc, 'base64');
              Y.applyUpdate(ydoc, new Uint8Array(docBuffer));
              console.log(`Loaded document ${docName} from Redis`);
              
              // Also cache in memory
              documents.set(docName, Y.encodeStateAsUpdate(ydoc));
            } else {
              console.log(`No existing state in Redis for ${docName}`);
            }
          } else {
            console.log(`Redis not connected, only using in-memory state for ${docName}`);
          }
        } catch (err) {
          console.error(`Error binding state for ${docName}:`, err);
        }
      },
      
      // Writing document state
      writeState: async (docName, ydoc) => {
        try {
          console.log(`Writing document state: ${docName}`);
          
          // Encode the document state
          const update = Y.encodeStateAsUpdate(ydoc);
          
          // Save document to memory
          documents.set(docName, update);
          
          // Write to Redis if connected
          if (redisClient.isOpen) {
            try {
              const key = `${prefix}${docName}`;
              await redisClient.set(key, Buffer.from(update).toString('base64'));
              console.log(`Saved document ${docName} to Redis`);
            } catch (err) {
              console.error('Failed to write to Redis:', err);
            }
          }
        } catch (err) {
          console.error('Error writing document state:', err);
        }
      },
      
      // Get all document keys from Redis
      getDocumentKeys: async () => {
        if (!redisClient.isOpen) return [];
        try {
          return await redisClient.keys(`${prefix}*`);
        } catch (err) {
          console.error('Error getting document keys:', err);
          return [];
        }
      },
      
      // Cleanup function
      cleanup: async () => {
        if (redisClient.isOpen) {
          await redisClient.quit();
          console.log('Redis connection closed');
        }
      }
    };

    // Connect to Redis
    try {
      await redisClient.connect();
      console.log('Connected to Redis at', redisUrl);
    } catch (error) {
      console.warn('Could not connect to Redis, using in-memory persistence only:', error.message);
    }

    console.log(`YJS persistence initialized (Redis: ${redisClient.isOpen ? 'connected' : 'disconnected'})`);
    return persistence;
  } catch (error) {
    console.error('Failed to initialize persistence:', error);
    
    // Fallback to pure in-memory persistence without Redis
    console.log('Falling back to in-memory persistence only');
    return {
      bindState: async (docName, ydoc) => {
        const existing = documents.get(docName);
        if (existing) {
          Y.applyUpdate(ydoc, existing);
        }
      },
      writeState: async (docName, ydoc) => {
        documents.set(docName, Y.encodeStateAsUpdate(ydoc));
      },
      getDocumentKeys: async () => {
        return Array.from(documents.keys());
      },
      cleanup: async () => {}
    };
  }
}

/**
 * Track room connections for presence awareness
 * 
 * @param {string} roomName - Name of the room
 * @param {string} userId - User ID from awareness
 * @param {WebSocket} conn - WebSocket connection
 */
function trackRoomConnection(roomName, userId, conn) {
  if (!roomConnections.has(roomName)) {
    roomConnections.set(roomName, new Map());
  }
  
  const roomUsers = roomConnections.get(roomName);
  roomUsers.set(userId || conn.id, conn);
  
  console.log(`User joined room ${roomName} - ${roomUsers.size} users connected`);
  
  // Set up cleanup on disconnect
  conn.on('close', () => {
    const roomUsers = roomConnections.get(roomName);
    if (roomUsers) {
      roomUsers.delete(userId || conn.id);
      console.log(`User left room ${roomName} - ${roomUsers.size} users connected`);
      
      // Clean up empty room maps
      if (roomUsers.size === 0) {
        roomConnections.delete(roomName);
      }
    }
  });
}

/**
 * Wait for a WebSocket client ping to confirm the connection is valid
 * 
 * @param {WebSocket} conn - WebSocket connection
 * @returns {Promise<boolean>} - Whether the connection is valid
 */
export function waitForClientPing(conn) {
  return new Promise((resolve) => {
    // Add a short timeout to verify the connection
    const timeout = setTimeout(() => {
      resolve(false);
    }, 500);

    // If we receive any message, consider the connection valid
    const messageHandler = () => {
      clearTimeout(timeout);
      conn.removeEventListener('message', messageHandler);
      resolve(true);
    };

    conn.addEventListener('message', messageHandler);
    
    // Send a ping to prompt a response
    if (conn.readyState === conn.OPEN) {
      conn.send(JSON.stringify({ type: 'ping' }));
    }
  });
}

/**
 * Sets up a YJS WebSocket connection with persistence
 * 
 * @param {WebSocket} conn - WebSocket connection
 * @param {http.IncomingMessage} req - HTTP request
 * @param {Object} persistence - Persistence provider
 */
export async function setupYjsWebSocketConnection(conn, req, persistence) {
  try {
    // Extract room name from URL - should be workflow-{id} format
    const url = new URL(req.url, 'http://localhost');
    const roomName = url.pathname.slice(1);

    if (!roomName || !roomName.startsWith('workflow-')) {
      console.warn('Invalid room name format, should be workflow-{id}:', roomName);
      conn.close();
      return;
    }

    console.log(`Connection to room: ${roomName}`);
    
    // Generate unique connection ID for tracking
    conn.id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    
    // Verify connection is valid before setup
    const isValid = await waitForClientPing(conn);
    if (!isValid && conn.readyState === conn.OPEN) {
      console.warn(`Invalid connection to room ${roomName}, closing`);
      conn.close();
      return;
    }
    
    // Setup YJS connection with persistence
    setupWSConnection(conn, req, { 
      docName: roomName,
      gc: true,
      persistence
    });
    
    // Track connection for presence awareness
    trackRoomConnection(roomName, null, conn);
    
    // Set up a handler to extract user ID when awareness is updated
    conn.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data && data.type === 'awareness' && data.awareness && data.awareness.user) {
          const userId = data.awareness.user.id;
          if (userId) {
            // Update tracking with the user ID
            trackRoomConnection(roomName, userId, conn);
          }
        }
      } catch (error) {
        // Ignore JSON parse errors - not all messages are JSON
      }
    });
  } catch (error) {
    console.error('Error setting up WebSocket connection:', error);
    if (conn.readyState === conn.OPEN) {
      conn.close();
    }
  }
} 