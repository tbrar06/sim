#!/usr/bin/env node

/**
 * YJS WebSocket Server for Workflow Collaboration
 * 
 * This standalone server handles the WebSocket connections for real-time
 * collaboration using YJS. It uses y-websocket as the provider and
 * y-redis for persistence of documents.
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRedisPersistence, setupYjsWebSocketConnection } from './utils.js';

// Configuration
const PORT = process.env.PORT || 1234;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'yjs-workflows:';

// Create HTTP server
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('YJS WebSocket Server is running');
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Track resources for cleanup
let persistence = null;

// Initialize Redis and start server
async function start() {
  try {
    // Initialize Redis persistence
    persistence = await createRedisPersistence(REDIS_URL, REDIS_PREFIX);
    
    // Handle WebSocket connections
    wss.on('connection', (conn, req) => {
      setupYjsWebSocketConnection(conn, req, persistence);
    });

    // Start the server
    server.listen(PORT, () => {
      console.log(`YJS WebSocket server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle WebSocket server errors
wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Handle server shutdown
const cleanup = async () => {
  console.log('Shutting down YJS WebSocket server...');
  
  // Close all WebSocket connections
  wss.clients.forEach(client => {
    client.close();
  });
  
  // Close Redis connection
  if (persistence && persistence.cleanup) {
    await persistence.cleanup();
  }
  
  // Close HTTP server
  server.close(() => {
    console.log('YJS WebSocket server closed');
    process.exit(0);
  });
};

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
start(); 