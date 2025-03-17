'use client'

import { createLogger } from '@/lib/logs/console-logger'
import { SyncManager } from './sync'
import { isLocalStorageMode } from './sync-core'
import { fetchWorkflowsFromDB, workflowSync } from './workflows/sync'
import { WorkflowYjsProvider } from '@/lib/yjs/provider'
import { WorkflowYjsBinding } from '@/lib/yjs/workflow-binding'
import { useWorkflowRegistry } from './workflows/registry/store'

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
    
    // Create YJS binding
    yjsBinding = new WorkflowYjsBinding()
    
    // Fetch data from database
    try {
      await fetchWorkflowsFromDB()
      logger.info('Successfully loaded workflows from database')
      
      // Initialize YJS for the active workflow if one exists
      const registry = useWorkflowRegistry.getState();
      const activeWorkflowId = registry.activeWorkflowId;
      
      if (activeWorkflowId && yjsBinding) {
        await yjsBinding.initializeWorkflow(activeWorkflowId);
        logger.info(`Initialized YJS for active workflow: ${activeWorkflowId}`);
        
        // Sync active workflow to YJS
        await yjsBinding.syncWorkflowToYJS(activeWorkflowId);
        
        // Also initialize all other workflows in the registry
        const workflowIds = Object.keys(registry.workflows);
        if (workflowIds.length > 1) {
          // Initialize other workflows in the background
          Promise.all(
            workflowIds
              .filter(id => id !== activeWorkflowId)
              .map(async (id) => {
                await yjsBinding?.initializeWorkflow(id);
                await yjsBinding?.syncWorkflowToYJS(id);
                logger.info(`Initialized YJS for workflow: ${id}`);
              })
          ).catch(error => {
            logger.error('Error initializing additional workflows:', error);
          });
        }
      }
      
      // Mark the binding as fully initialized
      yjsBinding?.markInitialized();
    } catch (error) {
      logger.error('Error fetching data from DB:', { error })
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
  
  // Clean up all YJS providers
  WorkflowYjsProvider.cleanup()
}

// Export individual sync managers for direct use
export { workflowSync }

/**
 * Initialize or get YJS for a specific workflow
 * This ensures each workflow has its own YJS connection
 */
export async function getYjsForWorkflow(workflowId: string): Promise<boolean> {
  if (!yjsBinding || !workflowId) return false;
  
  try {
    return await yjsBinding.initializeWorkflow(workflowId);
  } catch (error) {
    logger.error(`Failed to initialize YJS for workflow ${workflowId}:`, error);
    return false;
  }
}
