'use client'

import { createLogger } from '@/lib/logs/console-logger'
import { getAllWorkflowsWithValues } from '.'
import { API_ENDPOINTS } from '../constants'
import { createSingletonSyncManager } from '../sync'
import { useWorkflowRegistry } from './registry/store'
import { WorkflowMetadata } from './registry/types'
import { useSubBlockStore } from './subblock/store'
import { useWorkflowStore } from './workflow/store'
import { BlockState } from './workflow/types'
import { isLocalStorageMode } from '../sync-core'
import { getYjsBinding } from '../sync-registry'

const logger = createLogger('Workflows Sync')

// Flag to prevent immediate sync back to DB after loading from DB
let isLoadingFromDB = false
let loadingFromDBToken: string | null = null
let loadingFromDBStartTime = 0
const LOADING_TIMEOUT = 3000 // 3 seconds maximum loading time

// Track workflows that had scheduling enabled in previous syncs
const scheduledWorkflows = new Set<string>()

// Track initial load from DB - don't sync if we haven't loaded data yet
let initialDBLoadComplete = false

// Flag to track if YJS is handling updates
let yjsSyncing = false

// Sync lock to prevent rapid concurrent syncs that could cause data loss
let syncLock = false
let syncLockTimeout: NodeJS.Timeout | null = null

/**
 * Acquires a sync lock with timeout to prevent deadlocks
 * @returns true if lock was acquired, false otherwise
 */
function acquireSyncLock(): boolean {
  if (syncLock) return false
  
  syncLock = true
  
  // Auto-release lock after timeout to prevent deadlocks
  if (syncLockTimeout) {
    clearTimeout(syncLockTimeout)
  }
  
  syncLockTimeout = setTimeout(() => {
    syncLock = false
    syncLockTimeout = null
    logger.warn('Sync lock auto-released after timeout')
  }, 10000) // 10 second timeout
  
  return true
}

/**
 * Releases the sync lock
 */
function releaseSyncLock(): void {
  syncLock = false
  
  if (syncLockTimeout) {
    clearTimeout(syncLockTimeout)
    syncLockTimeout = null
  }
}

/**
 * Checks if the system is currently in the process of loading data from the database
 * Includes safety timeout to prevent permanent blocking of syncs
 * @returns true if loading is active, false otherwise
 */
export function isActivelyLoadingFromDB(): boolean {
  if (!loadingFromDBToken) return false
  
  // Safety check: ensure loading doesn't block syncs indefinitely
  const elapsedTime = Date.now() - loadingFromDBStartTime
  if (elapsedTime > LOADING_TIMEOUT) {
    loadingFromDBToken = null
    return false
  }
  
  return true
}

/**
 * Checks if a workflow has scheduling enabled
 * @param blocks The workflow blocks
 * @returns true if scheduling is enabled, false otherwise
 */
function hasSchedulingEnabled(blocks: Record<string, BlockState>): boolean {
  // Find the starter block
  const starterBlock = Object.values(blocks).find((block) => block.type === 'starter')
  if (!starterBlock) return false

  // Check if the startWorkflow value is 'schedule'
  const startWorkflow = starterBlock.subBlocks.startWorkflow?.value
  return startWorkflow === 'schedule'
}

/**
 * Updates or cancels the schedule for a workflow based on its current configuration
 * @param workflowId The workflow ID
 * @param state The workflow state
 * @returns A promise that resolves when the schedule update is complete
 */
async function updateWorkflowSchedule(workflowId: string, state: any): Promise<void> {
  try {
    const isScheduleEnabled = hasSchedulingEnabled(state.blocks)

    // Always call the schedule API to either update or cancel the schedule
    // The API will handle the logic to create, update, or delete the schedule
    const response = await fetch(API_ENDPOINTS.SCHEDULE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId,
        state,
      }),
    })

    if (!response.ok) {
      logger.error(
        `Failed to ${isScheduleEnabled ? 'update' : 'cancel'} schedule for workflow ${workflowId}:`,
        response.statusText
      )
      return
    }

    const result = await response.json()

    // Update our tracking of scheduled workflows
    if (isScheduleEnabled) {
      scheduledWorkflows.add(workflowId)
      logger.info(`Schedule updated for workflow ${workflowId}:`, result)
    } else {
      scheduledWorkflows.delete(workflowId)
      logger.info(`Schedule cancelled for workflow ${workflowId}:`, result)
    }
  } catch (error) {
    logger.error(`Error managing schedule for workflow ${workflowId}:`, { error })
  }
}

/**
 * Forces a synchronization of all workflows to the database immediately
 * This bypasses all debounce and throttle mechanisms
 * @returns A promise that resolves when the sync is complete
 */
export async function syncNow(): Promise<void> {
  try {
    // Skip if in local storage mode
    if (isLocalStorageMode()) return
    
    // Skip if actively loading from DB
    if (isActivelyLoadingFromDB()) {
      logger.info('Skipping immediate sync while loading from DB')
      return
    }
    
    // Try to acquire sync lock
    if (!acquireSyncLock()) {
      logger.info('Sync already in progress, skipping immediate sync')
      return
    }
    
    try {
      logger.info('Forcing immediate sync to database')
      
      // Get YJS binding for direct sync
      const yjsBinding = getYjsBinding()
      if (yjsBinding && typeof yjsBinding.forceSyncToDatabase === 'function') {
        // Use YJS binding to sync
        await yjsBinding.forceSyncToDatabase()
        logger.info('YJS force sync completed successfully')
      } else {
        // Fallback to legacy sync method if YJS not available
        const workflows = getAllWorkflowsWithValues()
        
        if (Object.keys(workflows).length === 0) {
          logger.warn('No workflows to sync')
          return
        }
        
        const response = await fetch('/api/db/workflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            workflows,
            preserveWorkflows: Object.keys(useWorkflowRegistry.getState().workflows)
          }),
        })
        
        if (!response.ok) {
          throw new Error(`Failed to sync workflows: ${response.statusText}`)
        }
        
        logger.info('Legacy force sync completed successfully')
      }
    } finally {
      releaseSyncLock()
    }
  } catch (error) {
    logger.error('Error during force sync:', error)
    releaseSyncLock()
  }
}

/**
 * Waits for any in-progress sync or DB loading to complete
 * @param timeoutMs Maximum time to wait in milliseconds (default: 5000)
 * @returns A promise that resolves when sync is complete or timeout is reached
 */
export async function ensureSyncComplete(timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now()
  
  // Check for YJS sync in progress
  const checkYjsSync = () => {
    const yjsBinding = getYjsBinding()
    return yjsBinding && 
      typeof yjsBinding.constructor === 'function' &&
      'isSyncInProgress' in yjsBinding.constructor && 
      (yjsBinding.constructor as any).isSyncInProgress()
  }
  
  // Helper to wait for sync to complete
  const waitForSync = async (): Promise<boolean> => {
    while (isActivelyLoadingFromDB() || syncLock || checkYjsSync()) {
      // Check for timeout
      if (Date.now() - startTime > timeoutMs) {
        logger.warn(`Sync wait timeout after ${timeoutMs}ms`)
        return false
      }
      
      // Wait a bit and check again
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    return true
  }
  
  return waitForSync()
}

/**
 * Fetches workflows from the database and updates the local stores
 * This function handles backwards syncing on initialization
 */
export async function fetchWorkflowsFromDB(): Promise<void> {
  if (isLocalStorageMode()) return

  try {
    // Try to acquire sync lock
    if (!acquireSyncLock()) {
      logger.info('Sync lock active, skipping DB fetch')
      return
    }
    
    try {
      // Set syncing flag to prevent other syncs during this operation
      yjsSyncing = true;
      
      const response = await fetch('/api/db/workflow')
      if (!response.ok) {
        throw new Error(`Failed to fetch workflows: ${response.statusText}`)
      }

      const data = await response.json()
      const { workflows } = data

      logger.info(`Fetched ${Object.keys(workflows).length} workflows from database`)

      // Create a unique token for this loading operation to detect when it's complete
      loadingFromDBToken = crypto.randomUUID()
      loadingFromDBStartTime = Date.now()
      isLoadingFromDB = true;

      try {
        // Before updating state, validate that we have actual data
        if (Object.keys(workflows).length === 0) {
          logger.warn('No workflows found in database, but continuing initialization');
        }

        // Update registry with workflows by updating each workflow individually
        const registryState = useWorkflowRegistry.getState();
        
        // First set active ID to null to prevent state updates during processing
        registryState.activeWorkflowId && useWorkflowRegistry.setState({ activeWorkflowId: null });
        
        // Update/create each workflow in the registry
        Object.entries(workflows).forEach(([id, workflow]: [string, any]) => {
          // Skip any malformed workflows
          if (!workflow || !workflow.name) {
            logger.warn(`Skipping malformed workflow with ID ${id}`);
            return;
          }

          // Create workflow metadata
          const metadata: WorkflowMetadata = {
            id,
            name: workflow.name,
            description: workflow.description || '',
            color: workflow.color || '#3972F6',
            lastModified: new Date(workflow.lastSynced || workflow.createdAt || Date.now()),
          };
          
          // Add workflow to registry
          useWorkflowRegistry.setState((state) => ({
            workflows: {
              ...state.workflows,
              [id]: metadata
            }
          }));
        });
        
        // Set active workflow if we have one
        const workflowIds = Object.keys(workflows);
        if (workflowIds.length > 0) {
          const activeWorkflowId = workflowIds[0];
          useWorkflowRegistry.setState({ activeWorkflowId });
          
          // Update workflow store with the workflow state
          const activeWorkflow = workflows[activeWorkflowId];
          if (activeWorkflow && activeWorkflow.state) {
            // Validate the state has the minimum required properties
            const blocks = activeWorkflow.state.blocks || {};
            const edges = Array.isArray(activeWorkflow.state.edges) ? activeWorkflow.state.edges : [];
            const loops = activeWorkflow.state.loops || {};
            
            // Use setState directly to update workflow state
            useWorkflowStore.setState({
              ...useWorkflowStore.getState(),
              blocks,
              edges,
              loops,
              isDeployed: activeWorkflow.state.isDeployed || false,
              deployedAt: activeWorkflow.state.deployedAt,
              lastSaved: Date.now(),
            });
            
            logger.info(`Set active workflow to ${activeWorkflowId} with ${Object.keys(blocks).length} blocks and ${edges.length} edges`);
          } else {
            logger.warn(`Active workflow ${activeWorkflowId} has no state or invalid state`);
          }
        } else {
          logger.warn('No workflows found to set as active');
        }

        // Mark that we've completed initial DB load
        initialDBLoadComplete = true;
        logger.info('Initial DB load completed successfully');
      } finally {
        // Mark loading as complete after a short delay to ensure state is properly processed
        setTimeout(() => {
          isLoadingFromDB = false;
          loadingFromDBToken = null;
          yjsSyncing = false;
          releaseSyncLock();
          logger.info('Database loading complete and flags reset');
        }, 500);
      }
    } catch (error) {
      logger.error('Error fetching workflows from DB:', error)
      // Reset loading state in case of error
      isLoadingFromDB = false
      loadingFromDBToken = null
      yjsSyncing = false;
      releaseSyncLock();
    }
  } catch (error) {
    logger.error('Error in fetchWorkflowsFromDB:', error)
  }
}

/**
 * Check if YJS is handling synchronization
 * @returns true if YJS is handling sync, false otherwise
 */
export function isYjsSyncing(): boolean {
  try {
    // First check our internal flag
    if (yjsSyncing) return true;
    
    // Check if YJS binding exists and is handling updates
    const yjsBinding: any = getYjsBinding();
    if (yjsBinding && typeof yjsBinding.constructor.isUpdatingFromYjs === 'function') {
      return yjsBinding.constructor.isUpdatingFromYjs();
    }
    return false;
  } catch (error) {
    logger.error('Error checking YJS sync status:', error);
    return false;
  }
}

// Syncs workflows to the database
export const workflowSync = createSingletonSyncManager('workflow', () => ({
  endpoint: '/api/db/workflow',
  preparePayload: async () => {
    // Don't sync if we're actively loading from DB
    if (isActivelyLoadingFromDB()) {
      logger.info('Skipping workflow sync while loading from DB');
      return { skipSync: true };
    }
    
    // Don't sync if YJS is handling updates
    if (isYjsSyncing()) {
      logger.info('Skipping workflow sync while YJS is syncing');
      return { skipSync: true };
    }
    
    // Don't sync if sync lock is active
    if (syncLock) {
      logger.info('Skipping workflow sync while sync lock is active');
      return { skipSync: true };
    }
    
    // Get workflows to sync
    const workflows = getAllWorkflowsWithValues();
    
    // Don't sync if we have no workflows to sync
    if (Object.keys(workflows).length === 0) {
      logger.info('No workflows to sync');
      return { skipSync: true };
    }
    
    return {
      workflows,
      // Inform the API to preserve these workflow IDs (prevent deletion)
      preserveWorkflows: Object.keys(useWorkflowRegistry.getState().workflows)
    };
  },
  onBeforeSync: async () => {
    // Try to acquire sync lock
    if (!acquireSyncLock()) {
      logger.info('Sync already in progress, skipping');
      return false;
    }
    
    // Skip sync if we're currently loading from DB
    if (isActivelyLoadingFromDB()) {
      releaseSyncLock();
      return false;
    }

    // Skip sync if initial DB load hasn't happened yet
    if (!initialDBLoadComplete) {
      releaseSyncLock();
      logger.info('Skipping sync before initial DB load');
      return false;
    }
    
    return true;
  },
  onSyncSuccess: async (data: any) => {
    // Process schedule updates for relevant workflows
    const workflows = getAllWorkflowsWithValues();
    
    try {
      for (const [id, workflow] of Object.entries(workflows)) {
        // Check if workflow has scheduling config that needs updating
        const hasScheduling = hasSchedulingEnabled(workflow.state.blocks);
        const wasScheduled = scheduledWorkflows.has(id);
        
        if (hasScheduling || wasScheduled) {
          await updateWorkflowSchedule(id, workflow.state);
        }
      }
    } catch (error) {
      logger.error('Error processing schedule updates:', error);
    } finally {
      releaseSyncLock();
    }
  },
  onSyncError: (error: any) => {
    logger.error('Error syncing workflows to API:', error);
    releaseSyncLock();
  },
}))
