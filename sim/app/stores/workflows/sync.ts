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
 * Fetches workflows from the database and updates the local stores
 * This function handles backwards syncing on initialization
 */
export async function fetchWorkflowsFromDB(): Promise<void> {
  if (isLocalStorageMode()) return

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
        logger.info('Database loading complete and flags reset');
      }, 500);
    }
  } catch (error) {
    logger.error('Error fetching workflows from DB:', error)
    // Reset loading state in case of error
    isLoadingFromDB = false
    loadingFromDBToken = null
    yjsSyncing = false;
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
    // Skip sync if YJS is currently updating (to prevent sync loops)
    if (isYjsSyncing()) {
      logger.info('Skipping workflow sync, YJS is already handling it');
      return { skipSync: true };
    }
    
    // Skip sync if we're using YJS (YJS binding will handle database sync)
    const yjs = getYjsBinding();
    if (!isLocalStorageMode() && yjs) {
      logger.info('YJS is handling synchronization, skipping workflow sync');
      return { skipSync: true };
    }

    // Skip DB sync while actively loading from DB to prevent data overwrites
    if (isActivelyLoadingFromDB()) {
      logger.info('Skipping sync while loading from DB');
      return { skipSync: true };
    }
    
    // Critical safety check: Do not sync empty workflows if we haven't completed initial DB load
    // This prevents wiping out database workflows during initialization
    const workflows = getAllWorkflowsWithValues();
    
    if (Object.keys(workflows).length === 0) {
      if (!initialDBLoadComplete) {
        logger.warn('Prevented potential data loss: Skipping sync of empty workflows before initial DB load');
        return { skipSync: true };
      }
      logger.warn('Syncing empty workflows set - this will clear all workflows in the database');
    }
    
    // Ensure all workflows have proper structure
    const validatedWorkflows: Record<string, any> = {};
    
    Object.entries(workflows).forEach(([id, workflow]) => {
      if (!workflow) return;
      
      // Ensure state has the required properties
      const state = workflow.state || {};
      validatedWorkflows[id] = {
        ...workflow,
        state: {
          blocks: state.blocks || {},
          edges: Array.isArray(state.edges) ? state.edges : [],
          loops: state.loops || {},
          isDeployed: state.isDeployed || false,
          deployedAt: state.deployedAt || null,
          lastSaved: Date.now()
        }
      };
    });
    
    return { workflows: validatedWorkflows };
  },
  onSyncSuccess: (response) => {
    logger.info('Workflow sync successful')
  },
  onSyncError: (error) => {
    logger.error('Workflow sync failed:', error)
  },
}))
