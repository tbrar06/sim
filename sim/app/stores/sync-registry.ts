'use client'

import { createLogger } from '@/lib/logs/console-logger'
import { SyncManager } from './sync'
import { isLocalStorageMode } from './sync-core'
import { fetchWorkflowsFromDB, workflowSync } from './workflows/sync'
import { WorkflowYjsProvider } from '@/lib/yjs/provider'
import { WorkflowYjsBinding } from '@/lib/yjs/workflow-binding'

const logger = createLogger('Sync Registry')

// Initialize managers lazily
let initialized = false
let initializing = false
let managers: SyncManager[] = []
let yjsBinding: WorkflowYjsBinding | null = null

/**
 * Initialize sync managers and fetch data from DB
 * Returns a promise that resolves when initialization is complete
 *
 * Note: Workflow scheduling is handled automatically by the workflowSync manager
 * when workflows are synced to the database. The scheduling logic checks if a
 * workflow has scheduling enabled in its starter block and updates the schedule
 * accordingly.
 */
export async function initializeSyncManagers(): Promise<boolean> {
  // Skip if already initialized or initializing
  if (initialized || initializing) {
    return initialized
  }

  initializing = true

  try {
    // Skip DB sync in local storage mode
    if (isLocalStorageMode()) {
      managers = [workflowSync]
      initialized = true
      return true
    }

    // Initialize sync managers first
    managers = [workflowSync]
    
    // Connect to YJS, but don't initialize binding yet
    let yjsProvider;
    try {
      yjsProvider = WorkflowYjsProvider.getInstance()
      await yjsProvider.connect()
      logger.info('Connected to YJS provider')
    } catch (error) {
      logger.error('Failed to connect to YJS:', error)
    }
    
    // Fetch data from database
    try {
      await fetchWorkflowsFromDB()
      logger.info('Successfully loaded workflows from database')
    } catch (error) {
      logger.error('Error fetching data from DB:', { error })
    }

    // Now initialize YJS binding after DB data is loaded
    if (yjsProvider) {
      yjsBinding = new WorkflowYjsBinding()
      
      // Mark YJS as initialized after a delay to ensure all DB data is processed
      setTimeout(() => {
        if (yjsBinding) {
          yjsBinding.markInitialized()
          logger.info('YJS binding has been initialized and synchronized')
        }
      }, 1000);
    }

    initialized = true;
    logger.info('Sync system fully initialized');
    return true;
  } catch (error) {
    logger.error('Error initializing sync managers:', { error })
    return false
  } finally {
    initializing = false
  }
}

/**
 * Check if sync managers are initialized
 */
export function isSyncInitialized(): boolean {
  return initialized
}

/**
 * Get all sync managers
 */
export function getSyncManagers(): SyncManager[] {
  return managers
}

/**
 * Get YJS binding if available
 */
export function getYjsBinding(): WorkflowYjsBinding | null {
  return yjsBinding
}

/**
 * Reset all sync managers
 */
export function resetSyncManagers(): void {
  initialized = false
  initializing = false
  managers = []
  
  if (yjsBinding) {
    yjsBinding.dispose()
    yjsBinding = null
  }
}

// Export individual sync managers for direct use
export { workflowSync }
