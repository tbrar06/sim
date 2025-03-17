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

export class WorkflowYjsBinding {
  private yjsProviders: Map<string, WorkflowYjsProvider> = new Map()
  private yWorkflowDocs: Map<string, Y.Doc> = new Map()
  private yWorkflows: Map<string, Y.Map<any>> = new Map()
  private activeWorkflowId: string | null = null
  private debouncedSync: ReturnType<typeof debounce>
  private isInitialized = false
  private pendingOperations: Map<string, Promise<void>> = new Map()
  private updateLock = false
  
  constructor() {
    // Create debounced sync function
    this.debouncedSync = debounce(this.syncToDatabase.bind(this), 2000)
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
            const value = yWorkflow.get(key)
            if (key === 'state') {
              this.handleWorkflowStateUpdate(workflowId, value)
            } else if (key === 'metadata') {
              this.handleWorkflowMetadataUpdate(workflowId, value)
            }
          }
        })
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
    
    logger.info(`Handling YJS workflow state update for: ${workflowId}`)
    
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
  }
  
  /**
   * Handle a workflow metadata update from YJS
   */
  private handleWorkflowMetadataUpdate(workflowId: string, metadata: any): void {
    if (!metadata) {
      logger.warn(`Received null/undefined workflow metadata update for ID: ${workflowId}`)
      return
    }
    
    logger.info(`Handling YJS workflow metadata update for: ${workflowId}`)
    
    // Update registry with workflow metadata
    useWorkflowRegistry.getState().updateWorkflow(workflowId, {
      id: workflowId,
      name: metadata.name || 'Untitled Workflow',
      description: metadata.description || '',
      lastModified: new Date(),
      color: metadata.color || '#3972F6',
    })
  }

  /**
   * Sync workflows to database
   */
  private async syncToDatabase(): Promise<void> {
    if (!this.isInitialized) return;
    
    try {
      const processedWorkflows: Record<string, any> = {};
      
      // Process all initialized workflows
      for (const [workflowId, yWorkflow] of this.yWorkflows.entries()) {
        const state = yWorkflow.get('state')
        const metadata = yWorkflow.get('metadata')
        
        if (!state || !metadata) continue;
        
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
            lastSaved: Date.now()
          }
        };
      }
      
      if (Object.keys(processedWorkflows).length === 0) {
        logger.warn('No valid workflows to sync to database');
        return;
      }
      
      logger.info(`Syncing ${Object.keys(processedWorkflows).length} workflows to database`);
      
      const response = await fetch('/api/db/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflows: processedWorkflows }),
      })

      if (!response.ok) {
        throw new Error(`Failed to sync workflows: ${response.statusText}`)
      }
      
      logger.info('Successfully synced YJS state to database')
    } catch (error) {
      logger.error('Failed to sync workflows to database:', error)
    }
  }

  /**
   * Update workflow state in YJS
   */
  async updateWorkflowState(workflowId: string, state: any): Promise<void> {
    if (updatingFromYjs) {
      logger.info(`Skipping YJS update as it originated from YJS for workflow: ${workflowId}`)
      return;
    }
    
    return this.withLock(workflowId, async () => {
      try {
        // Ensure workflow is initialized
        if (!this.yWorkflows.has(workflowId)) {
          logger.info(`Workflow ${workflowId} not initialized yet, initializing now...`)
          const success = await this.initializeWorkflow(workflowId)
          if (!success) {
            throw new Error(`Failed to initialize workflow ${workflowId} for YJS update`)
          }
        }
        
        const yWorkflow = this.yWorkflows.get(workflowId)
        if (!yWorkflow) {
          throw new Error(`YJS workflow map not found for ID: ${workflowId}`)
        }
        
        logger.info(`Updating YJS state for workflow: ${workflowId}`)
        
        // Get subblock values for this workflow
        const subblockValues = useSubBlockStore.getState().workflowValues[workflowId] || {}
        
        // Include subblock values in the state
        const workflowState = {
          blocks: state.blocks || {},
          edges: state.edges || [],
          loops: state.loops || {},
          isDeployed: state.isDeployed || false,
          deployedAt: state.deployedAt || null,
          lastSaved: Date.now(),
          subblockValues
        }
        
        // Update YJS document
        yWorkflow.set('state', workflowState)
        logger.info(`Successfully updated YJS state for workflow: ${workflowId}`)
        
        // Trigger a database sync
        this.debouncedSync()
      } catch (error) {
        logger.error(`Error updating YJS state for workflow ${workflowId}:`, error)
        throw error
      }
    })
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
        
        // Update YJS document
        yWorkflow.set('metadata', workflowMetadata)
        
        // Trigger a database sync
        this.debouncedSync()
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
        
        // Trigger a database sync
        this.debouncedSync()
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
   * Check if updates are coming from YJS
   */
  static isUpdatingFromYjs(): boolean {
    return updatingFromYjs;
  }
} 