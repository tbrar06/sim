'use client'

import { createLogger } from '@/lib/logs/console-logger'
import * as Y from 'yjs'
import { WorkflowYjsProvider } from './provider'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { debounce } from 'lodash'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'

const logger = createLogger('YJS Workflow Binding')

// Flag to track changes originating from YJS
let updatingFromYjs = false;
// Flag to track whether a sync is currently in progress
let globalSyncInProgress = false;
// Maintain a list of workflows that need to be immediately synced
const prioritySyncWorkflows = new Set<string>();

export class WorkflowYjsBinding {
  private yjsProviders: Map<string, WorkflowYjsProvider> = new Map()
  private yWorkflowDocs: Map<string, Y.Doc> = new Map()
  private yWorkflows: Map<string, Y.Map<any>> = new Map()
  private activeWorkflowId: string | null = null
  private debouncedSync: ReturnType<typeof debounce>
  private isInitialized = false
  private pendingOperations: Map<string, Promise<void>> = new Map()
  private updateLock = false
  private syncInProgress = false
  private lastSyncTimestamp: Record<string, number> = {}
  private syncQueue: Array<() => Promise<void>> = []
  private syncPromise: Promise<void> | null = null
  private waitingForSync = new Set<string>()
  
  constructor() {
    // Create debounced sync function - use a shorter delay to be more responsive
    this.debouncedSync = debounce(this.syncToDatabase.bind(this), 1000)
  }

  /**
   * Initialize the binding for a specific workflow
   * This should be called when a workflow is loaded/activated
   */
  async initializeWorkflow(workflowId: string): Promise<boolean> {
    if (!workflowId) {
      logger.error('Cannot initialize workflow with null ID')
      return false
    }

    try {
      // Already initialized for this workflow
      if (this.yWorkflows.has(workflowId)) {
        logger.info(`Workflow ${workflowId} already initialized in YJS`)
        return true
      }

      // Get or create provider for this workflow
      const provider = WorkflowYjsProvider.getInstance(workflowId)
      
      // Connect to the workflow-specific room
      logger.info(`Connecting to workflow room for ${workflowId}...`)
      await provider.connect()
      
      // Store the provider
      this.yjsProviders.set(workflowId, provider)
      
      // Get the Y.Doc for this workflow
      const doc = provider.getDoc()
      this.yWorkflowDocs.set(workflowId, doc)
      
      // Get or create the workflows map with a consistent name
      const mapName = `workflow-${workflowId}`
      logger.info(`Creating YJS map: ${mapName}`)
      const yWorkflow = doc.getMap(mapName)
      this.yWorkflows.set(workflowId, yWorkflow)
      
      // Set up observers for this workflow
      this.setupWorkflowObservers(workflowId, yWorkflow)
      
      // If this is a newly created workflow, immediately mark it for priority sync
      const isNew = !yWorkflow.get('metadata')
      if (isNew) {
        prioritySyncWorkflows.add(workflowId)
        logger.info(`Marked new workflow ${workflowId} for priority sync`)
      }
      
      logger.info(`Successfully initialized YJS binding for workflow: ${workflowId}`)
      return true
    } catch (error) {
      logger.error(`Failed to initialize YJS for workflow ${workflowId}:`, error)
      // Try to clean up any partially initialized state
      WorkflowYjsProvider.cleanup(workflowId)
      this.yWorkflows.delete(workflowId)
      this.yWorkflowDocs.delete(workflowId)
      this.yjsProviders.delete(workflowId)
      return false
    }
  }
  
  /**
   * Set up observers for a specific workflow
   */
  private setupWorkflowObservers(workflowId: string, yWorkflow: Y.Map<any>): void {
    yWorkflow.observe(event => {
      // Skip if we're actively updating this workflow
      if (this.isLocked(workflowId)) return
      
      logger.info(`YJS observed changes in workflow ${workflowId}`)
      
      // Set flag to indicate updates are coming from YJS
      updatingFromYjs = true
      
      try {
        // Process all changes
        event.keys.forEach((change, key) => {
          if (change.action === 'add' || change.action === 'update') {
            try {
              const value = yWorkflow.get(key)
              if (value === undefined || value === null) {
                logger.warn(`Received null/undefined value for key ${key} in workflow ${workflowId}`)
                return
              }
              
              if (key === 'state') {
                this.handleWorkflowStateUpdate(workflowId, value)
              } else if (key === 'metadata') {
                this.handleWorkflowMetadataUpdate(workflowId, value)
              }
            } catch (valueError) {
              logger.error(`Error processing YJS value for key ${key}:`, valueError)
            }
          }
        })
      } catch (observeError) {
        logger.error(`Error in YJS observer for workflow ${workflowId}:`, observeError)
      } finally {
        // Reset the flag
        updatingFromYjs = false
      }
    })
  }

  /**
   * Handle a workflow state update from YJS
   */
  private handleWorkflowStateUpdate(workflowId: string, state: any): void {
    if (!state) {
      logger.warn(`Received null/undefined workflow state update for ID: ${workflowId}`)
      return
    }
    
    try {
      logger.info(`Handling YJS workflow state update for: ${workflowId}`)
      
      // Validate state data before applying
      if (!this.validateWorkflowState(state)) {
        logger.warn(`Ignoring invalid state update for workflow ${workflowId}`)
        return
      }
      
      // Only update active workflow in the store
      const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId
      if (workflowId === activeWorkflowId) {
        logger.info(`Updating active workflow state from YJS for: ${workflowId}`)
        
        // Use setState to update the workflow state directly
        useWorkflowStore.setState({
          ...useWorkflowStore.getState(),
          blocks: state.blocks || {},
          edges: state.edges || [],
          loops: state.loops || {},
          isDeployed: state.isDeployed || false,
          deployedAt: state.deployedAt,
          lastSaved: Date.now(),
        })
        
        // Also update subblock values if present
        if (state.subblockValues) {
          useSubBlockStore.setState((s) => ({
            workflowValues: {
              ...s.workflowValues,
              [workflowId]: state.subblockValues
            }
          }))
        }
      }
    } catch (error) {
      logger.error(`Error handling workflow state update for ${workflowId}:`, error)
    }
  }
  
  /**
   * Validate workflow state data
   */
  private validateWorkflowState(state: any): boolean {
    if (!state) return false
    
    try {
      // Check blocks
      if (state.blocks && typeof state.blocks === 'object') {
        // Ensure blocks object is not empty if present
        if (Object.keys(state.blocks).length === 0 && state.lastSaved) {
          logger.warn('Workflow state has empty blocks object but has lastSaved timestamp')
        }
        
        // Validate all blocks have required fields
        for (const [blockId, block] of Object.entries(state.blocks)) {
          if (!block || typeof block !== 'object') {
            logger.warn(`Invalid block structure for ${blockId}`)
            return false
          }
          
          // Basic validation of block structure
          const blockObj = block as Record<string, any>
          if (!blockObj.id || !blockObj.type) {
            logger.warn(`Block ${blockId} missing required fields`)
          }
        }
      }
      
      // Check edges
      if (state.edges) {
        if (!Array.isArray(state.edges)) {
          logger.warn('Workflow state edges is not an array')
          return false
        }
      }
      
      return true
    } catch (error) {
      logger.error('Error validating workflow state:', error)
      return false
    }
  }
  
  /**
   * Handle a workflow metadata update from YJS
   */
  private handleWorkflowMetadataUpdate(workflowId: string, metadata: any): void {
    if (!metadata) {
      logger.warn(`Received null/undefined workflow metadata update for ID: ${workflowId}`)
      return
    }
    
    try {
      logger.info(`Handling YJS workflow metadata update for: ${workflowId}`)
      
      // Validate that this is a proper metadata object
      if (!metadata.id && !metadata.name) {
        logger.warn(`Invalid metadata update for workflow ${workflowId}`)
        return
      }
      
      // Update registry with workflow metadata
      useWorkflowRegistry.getState().updateWorkflow(workflowId, {
        id: workflowId,
        name: metadata.name || 'Untitled Workflow',
        description: metadata.description || '',
        lastModified: new Date(),
        color: metadata.color || '#3972F6',
      })
    } catch (error) {
      logger.error(`Error handling workflow metadata update for ${workflowId}:`, error)
    }
  }

  /**
   * Sync workflows to database
   */
  async syncToDatabase(): Promise<void> {
    if (!this.isInitialized) return;
    
    // Set global sync flag
    globalSyncInProgress = true;
    
    // If a sync is already in progress, queue this sync to run after the current one completes
    if (this.syncInProgress) {
      logger.info('Sync already in progress, queueing additional sync');
      
      // Create a sync promise for external code to await on
      if (!this.syncPromise) {
        this.syncPromise = new Promise<void>((resolve) => {
          this.syncQueue.push(async () => {
            await this.executeSyncToDatabase();
            resolve();
          });
        });
      }
      
      return this.syncPromise;
    }
    
    try {
      this.syncInProgress = true;
      
      // Create a sync promise for external code to await on
      this.syncPromise = this.executeSyncToDatabase();
      await this.syncPromise;
    } finally {
      this.syncInProgress = false;
      this.syncPromise = null;
      
      // Process any queued syncs
      if (this.syncQueue.length > 0) {
        const nextSync = this.syncQueue.shift();
        if (nextSync) {
          logger.info('Processing queued sync operation');
          nextSync().catch(error => {
            logger.error('Error in queued sync operation:', error);
          });
        }
      } else {
        // If there are no more sync operations, reset global flag
        globalSyncInProgress = false;
      }
      
      // Resolve any waiting sync promises
      for (const workflowId of this.waitingForSync) {
        this.waitingForSync.delete(workflowId);
      }
    }
  }
  
  /**
   * Execute the actual database synchronization
   */
  private async executeSyncToDatabase(): Promise<void> {
    try {
      const processedWorkflows: Record<string, any> = {};
      const syncTimestamp = Date.now();
      const currentWorkflows = useWorkflowRegistry.getState().workflows;
      
      // If we have no workflows in the registry, don't attempt to sync
      if (Object.keys(currentWorkflows).length === 0) {
        logger.info('No workflows in registry, skipping sync');
        return;
      }
      
      // First, process priority workflows (newly created ones)
      if (prioritySyncWorkflows.size > 0) {
        logger.info(`Processing ${prioritySyncWorkflows.size} priority workflows`);
        
        for (const workflowId of prioritySyncWorkflows) {
          const yWorkflow = this.yWorkflows.get(workflowId);
          const metadata = currentWorkflows[workflowId];
          
          if (!metadata) {
            logger.warn(`Priority workflow ${workflowId} not found in registry, skipping`);
            continue;
          }
          
          // If this workflow isn't in YJS yet, add it
          if (!yWorkflow || !yWorkflow.get('metadata')) {
            await this.initializeWorkflow(workflowId);
            await this.syncWorkflowToYJS(workflowId);
          }
          
          // Get updated YJS data
          const updatedYWorkflow = this.yWorkflows.get(workflowId);
          if (!updatedYWorkflow) {
            logger.warn(`Failed to initialize priority workflow ${workflowId} in YJS`);
            continue;
          }
          
          const state = updatedYWorkflow.get('state') || {};
          const yMetadata = updatedYWorkflow.get('metadata') || {};
          
          processedWorkflows[workflowId] = {
            id: workflowId,
            name: metadata.name || yMetadata.name || 'Untitled Workflow',
            description: metadata.description || yMetadata.description || '',
            color: metadata.color || yMetadata.color || '#3972F6',
            state: {
              blocks: state.blocks || {},
              edges: state.edges || [],
              loops: state.loops || {},
              isDeployed: state.isDeployed || false,
              deployedAt: state.deployedAt || null,
              lastSaved: syncTimestamp
            }
          };
        }
        
        // Clear the priority list after processing
        prioritySyncWorkflows.clear();
      }
      
      // Process all initialized workflows
      for (const [workflowId, yWorkflow] of this.yWorkflows.entries()) {
        // Skip workflows already processed as priority
        if (processedWorkflows[workflowId]) continue;
        
        const state = yWorkflow.get('state');
        const metadata = yWorkflow.get('metadata');
        
        // Skip workflows with incomplete data
        if (!state || !metadata) {
          logger.warn(`Skipping workflow ${workflowId} with incomplete data for sync`);
          continue;
        }
        
        // Skip if this workflow hasn't changed since last sync
        if (this.lastSyncTimestamp[workflowId] && 
            state.lastSaved && 
            state.lastSaved <= this.lastSyncTimestamp[workflowId]) {
          // logger.info(`Skipping unchanged workflow ${workflowId} for sync`);
          continue;
        }
        
        processedWorkflows[workflowId] = {
          id: workflowId,
          name: metadata.name || 'Untitled Workflow',
          description: metadata.description || '',
          color: metadata.color || '#3972F6',
          state: {
            blocks: state.blocks || {},
            edges: state.edges || [],
            loops: state.loops || {},
            isDeployed: state.isDeployed || false,
            deployedAt: state.deployedAt || null,
            lastSaved: syncTimestamp
          }
        };
      }
      
      if (Object.keys(processedWorkflows).length === 0) {
        logger.info('No workflows to sync to database');
        return;
      }
      
      // Log workflows being synced
      const workflowIds = Object.keys(processedWorkflows);
      logger.info(`Syncing ${workflowIds.length} workflows to database: ${workflowIds.join(', ')}`);
      
      // Get current workflows from registry to ensure we don't lose data
      const currentWorkflowIds = Object.keys(currentWorkflows);
      
      const response = await fetch('/api/db/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          workflows: processedWorkflows,
          preserveWorkflows: currentWorkflowIds // Tell the server to preserve these workflows
        }),
        credentials: 'same-origin'
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to sync workflows (${response.status}): ${errorText}`);
      }
      
      // Process successful response
      const result = await response.json();
      
      if (result.success) {
        // Update last sync timestamps for all successfully synced workflows
        for (const workflowId of workflowIds) {
          this.lastSyncTimestamp[workflowId] = syncTimestamp;
        }
        logger.info(`Successfully synced ${workflowIds.length} workflows to database`);
      } else if (result.error) {
        throw new Error(`Server reported sync error: ${result.error}`);
      }
    } catch (error) {
      logger.error('Failed to sync workflows to database:', error);
      // We don't rethrow the error to avoid breaking the debounce chain
    }
  }

  /**
   * Force an immediate sync
   */
  async forceSyncToDatabase(): Promise<void> {
    // Cancel any pending debounced sync
    (this.debouncedSync as any).cancel();
    
    // Run sync directly
    return this.syncToDatabase();
  }

  /**
   * Update workflow state in YJS
   */
  async updateWorkflowState(workflowId: string, state: any): Promise<void> {
    if (updatingFromYjs) {
      logger.info(`Skipping YJS update as it originated from YJS for workflow: ${workflowId}`);
      return;
    }
    
    return this.withLock(workflowId, async () => {
      try {
        // Ensure workflow is initialized
        if (!this.yWorkflows.has(workflowId)) {
          logger.info(`Workflow ${workflowId} not initialized yet, initializing now...`);
          const success = await this.initializeWorkflow(workflowId);
          if (!success) {
            throw new Error(`Failed to initialize workflow ${workflowId} for YJS update`);
          }
        }
        
        const yWorkflow = this.yWorkflows.get(workflowId);
        if (!yWorkflow) {
          throw new Error(`YJS workflow map not found for ID: ${workflowId}`);
        }
        
        logger.info(`Updating YJS state for workflow: ${workflowId}`);
        
        // Get subblock values for this workflow
        const subblockValues = useSubBlockStore.getState().workflowValues[workflowId] || {};
        
        // Include subblock values in the state
        const workflowState = {
          blocks: state.blocks || {},
          edges: state.edges || [],
          loops: state.loops || {},
          isDeployed: state.isDeployed || false,
          deployedAt: state.deployedAt || null,
          lastSaved: Date.now(),
          subblockValues
        };
        
        // Check if this is a newly created workflow
        const isNew = !yWorkflow.get('state');
        
        // Update YJS document - handle potential errors
        try {
          yWorkflow.set('state', workflowState);
          logger.info(`Successfully updated YJS state for workflow: ${workflowId}`);
          
          // For new workflows, mark for priority sync
          if (isNew) {
            prioritySyncWorkflows.add(workflowId);
            
            // Force immediate sync for new workflows
            await this.forceSyncToDatabase();
            return;
          }
        } catch (yjsError) {
          logger.error(`YJS error while updating state for workflow ${workflowId}:`, yjsError);
          
          // If there was an error, retry with a safer approach
          try {
            const doc = this.yWorkflowDocs.get(workflowId);
            if (doc) {
              doc.transact(() => {
                yWorkflow.set('state', workflowState);
              });
              logger.info(`Recovered from YJS error for workflow: ${workflowId}`);
            }
          } catch (retryError) {
            logger.error(`Failed retry updating YJS for workflow ${workflowId}:`, retryError);
            throw retryError;
          }
        }
        
        // Trigger a database sync
        await this.debouncedSync();
      } catch (error) {
        logger.error(`Error updating YJS state for workflow ${workflowId}:`, error);
        throw error;
      }
    });
  }
  
  /**
   * Update workflow metadata in YJS
   */
  async updateWorkflowMetadata(workflowId: string, metadata: any): Promise<void> {
    if (updatingFromYjs) return;
    
    return this.withLock(workflowId, async () => {
      try {
        // Ensure workflow is initialized
        if (!this.yWorkflows.has(workflowId)) {
          await this.initializeWorkflow(workflowId)
        }
        
        const yWorkflow = this.yWorkflows.get(workflowId)
        if (!yWorkflow) {
          throw new Error(`YJS workflow map not found for ID: ${workflowId}`)
        }
        
        logger.info(`Updating YJS metadata for workflow: ${workflowId}`)
        
        // Ensure we have all required fields
        const workflowMetadata = {
          id: workflowId,
          name: metadata.name || 'Untitled Workflow',
          description: metadata.description || '',
          color: metadata.color || '#3972F6',
          lastModified: new Date()
        }
        
        // Check if this is a new workflow
        const isNew = !yWorkflow.get('metadata');
        
        // Update YJS document
        try {
          yWorkflow.set('metadata', workflowMetadata);
          
          // For new workflows, mark for priority sync
          if (isNew) {
            prioritySyncWorkflows.add(workflowId);
            
            // Force immediate sync for new workflows
            await this.forceSyncToDatabase();
            return;
          }
        } catch (yjsError) {
          logger.error(`YJS error while updating metadata for workflow ${workflowId}:`, yjsError);
          
          // If there was an error, retry with a safer approach
          try {
            const doc = this.yWorkflowDocs.get(workflowId);
            if (doc) {
              doc.transact(() => {
                yWorkflow.set('metadata', workflowMetadata);
              });
              logger.info(`Recovered from YJS error for workflow metadata: ${workflowId}`);
            }
          } catch (retryError) {
            logger.error(`Failed retry updating YJS metadata for workflow ${workflowId}:`, retryError);
          }
        }
        
        // Trigger a database sync
        await this.debouncedSync()
      } catch (error) {
        logger.error(`Error updating YJS metadata for workflow ${workflowId}:`, error)
        throw error
      }
    })
  }
  
  /**
   * Delete a workflow from YJS
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    if (updatingFromYjs) return;
    
    return this.withLock(workflowId, async () => {
      try {
        // Check if workflow is initialized
        if (!this.yWorkflows.has(workflowId)) {
          return // Nothing to delete
        }
        
        logger.info(`Deleting workflow from YJS: ${workflowId}`)
        
        // Clear the workflow data
        const yWorkflow = this.yWorkflows.get(workflowId)
        if (yWorkflow) {
          yWorkflow.clear()
        }
        
        // Clean up provider
        WorkflowYjsProvider.cleanup(workflowId)
        
        // Remove from local maps
        this.yWorkflows.delete(workflowId)
        this.yWorkflowDocs.delete(workflowId)
        this.yjsProviders.delete(workflowId)
        
        // Remove from priority list if present
        prioritySyncWorkflows.delete(workflowId)
        
        // Trigger a database sync
        await this.forceSyncToDatabase()
      } catch (error) {
        logger.error(`Error deleting workflow ${workflowId} from YJS:`, error)
        throw error
      }
    })
  }
  
  /**
   * Set the active workflow
   */
  async setActiveWorkflow(workflowId: string): Promise<void> {
    if (this.activeWorkflowId === workflowId) return;
    
    try {
      // Initialize the new active workflow
      await this.initializeWorkflow(workflowId)
      
      // Update active workflow ID
      this.activeWorkflowId = workflowId
      
      logger.info(`Set active workflow in YJS to: ${workflowId}`)
    } catch (error) {
      logger.error(`Error setting active workflow to ${workflowId}:`, error)
      throw error
    }
  }

  /**
   * Execute a function with a lock to prevent concurrent updates to the same workflow
   */
  private async withLock<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    // Create a unique key for this operation
    const operationKey = `${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    
    // Create and register the operation
    const operation = (async () => {
      // Wait for any existing operations on this workflow to complete
      while (this.isLocked(workflowId)) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      
      // Set update lock
      this.setLock(workflowId, true)
      
      try {
        return await fn()
      } finally {
        // Release lock
        this.setLock(workflowId, false)
        // Remove this operation from pending operations
        this.pendingOperations.delete(operationKey)
      }
    })()
    
    // Register this operation
    this.pendingOperations.set(operationKey, operation as Promise<void>)
    
    // Return the operation result
    return operation
  }
  
  /**
   * Check if a workflow is locked for updates
   */
  private isLocked(workflowId: string): boolean {
    return Array.from(this.pendingOperations.values()).some(op => 
      op !== null && typeof op === 'object' && 'workflowId' in op && op.workflowId === workflowId
    ) || this.updateLock;
  }
  
  /**
   * Set the update lock state
   */
  private setLock(workflowId: string, state: boolean): void {
    this.updateLock = state;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    // Cancel debounced sync
    (this.debouncedSync as any).cancel();
    
    // Clean up all providers
    WorkflowYjsProvider.cleanup();
    
    // Clear maps
    this.yWorkflows.clear();
    this.yWorkflowDocs.clear();
    this.yjsProviders.clear();
  }

  /**
   * Mark binding as initialized and ready to react to changes
   */
  markInitialized(): void {
    this.isInitialized = true;
    // No need to sync right away - will be done when workflows are initialized
  }
  
  /**
   * Sync current workflow state to YJS
   */
  async syncWorkflowToYJS(workflowId: string): Promise<void> {
    const registry = useWorkflowRegistry.getState();
    const metadata = registry.workflows[workflowId];
    
    if (!metadata) {
      logger.warn(`Cannot sync non-existent workflow to YJS: ${workflowId}`);
      return;
    }
    
    try {
      // Get workflow state
      const isActive = registry.activeWorkflowId === workflowId;
      let state;
      
      if (isActive) {
        // Get state from the workflow store
        const workflowState = useWorkflowStore.getState();
        const subblockValues = useSubBlockStore.getState().workflowValues[workflowId] || {};
        
        state = {
          blocks: workflowState.blocks || {},
          edges: workflowState.edges || [],
          loops: workflowState.loops || {},
          isDeployed: workflowState.isDeployed || false,
          deployedAt: workflowState.deployedAt || null,
          lastSaved: Date.now(),
          subblockValues
        };
      }
      
      // Update workflow in YJS
      if (state) {
        await this.updateWorkflowState(workflowId, state);
      }
      
      // Update metadata in YJS
      await this.updateWorkflowMetadata(workflowId, metadata);
      
      logger.info(`Synced workflow ${workflowId} to YJS`);
    } catch (error) {
      logger.error(`Error syncing workflow ${workflowId} to YJS:`, error);
    }
  }
  
  /**
   * Wait for any in-progress sync to complete
   */
  async waitForSync(workflowId?: string): Promise<void> {
    if (!this.syncInProgress) return;
    
    // Add this workflow to the list of workflows waiting for sync
    if (workflowId) {
      this.waitingForSync.add(workflowId);
    }
    
    // Wait for the current sync to complete
    return this.syncPromise || Promise.resolve();
  }
  
  /**
   * Check if updates are coming from YJS
   */
  static isUpdatingFromYjs(): boolean {
    return updatingFromYjs;
  }
  
  /**
   * Check if a sync is in progress
   */
  static isSyncInProgress(): boolean {
    return globalSyncInProgress;
  }
} 