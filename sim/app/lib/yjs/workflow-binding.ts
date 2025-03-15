'use client'

import { createLogger } from '@/lib/logs/console-logger'
import * as Y from 'yjs'
import { WorkflowYjsProvider } from './provider'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { debounce } from 'lodash'

const logger = createLogger('YJS Workflow Binding')

// Flag to track changes originating from YJS
let updatingFromYjs = false;

export class WorkflowYjsBinding {
  private yjsProvider: WorkflowYjsProvider
  private yWorkflows: Y.Map<any>
  private yActiveWorkflow: Y.Map<any>
  private debouncedSync: ReturnType<typeof debounce>
  private isInitialized = false
  private ignoreLocalChanges = false // To prevent update loops

  constructor() {
    this.yjsProvider = WorkflowYjsProvider.getInstance()
    const doc = this.yjsProvider.getDoc()
    
    // Initialize YJS maps
    this.yWorkflows = doc.getMap('workflows')
    this.yActiveWorkflow = doc.getMap('activeWorkflow')

    // Create debounced sync function
    this.debouncedSync = debounce(this.syncToDatabase.bind(this), 2000)

    // Set up observers after a short delay to ensure DB data is loaded first
    setTimeout(() => {
      this.setupObservers()
      logger.info('YJS binding initialized with observers')
    }, 2000) // Extended delay to ensure DB load completes
  }

  private setupObservers(): void {
    // Observe workflow changes
    this.yWorkflows.observe(event => {
      // Skip updates if we're ignoring local changes
      if (this.ignoreLocalChanges) return;
      
      logger.info('YJS observed workflow changes:', Array.from(event.keys.keys()).join(', '))
      
      // Set flag to indicate updates are coming from YJS
      updatingFromYjs = true;
      
      try {
        // Use keys Map from the event to process changes
        event.keys.forEach((change, key) => {
          if (change.action === 'add' || change.action === 'update') {
            const workflow = this.yWorkflows.get(key)
            this.handleWorkflowUpdate(key, workflow)
          } else if (change.action === 'delete') {
            this.handleWorkflowDelete(key)
          }
        })
      } finally {
        // Reset the flag
        updatingFromYjs = false;
      }
    })

    // Observe active workflow changes
    this.yActiveWorkflow.observe(event => {
      // Skip updates if we're ignoring local changes
      if (this.ignoreLocalChanges) return;
      
      logger.info('YJS observed active workflow change')
      
      // Set flag to indicate updates are coming from YJS
      updatingFromYjs = true;
      
      try {
        // Use keys Map from the event to process changes
        event.keys.forEach((change, key) => {
          if (change.action === 'add' || change.action === 'update') {
            const activeWorkflowId = this.yActiveWorkflow.get(key)
            this.handleActiveWorkflowUpdate(activeWorkflowId)
          }
        })
      } finally {
        // Reset the flag
        updatingFromYjs = false;
      }
    })
    
    // Mark as initialized after observers are set up
    this.isInitialized = true;
  }

  private handleWorkflowUpdate(workflowId: string, workflow: any): void {
    if (!workflow) {
      logger.warn(`Received null/undefined workflow update for ID: ${workflowId}`)
      return
    }
    
    logger.info(`Handling YJS workflow update for: ${workflowId}`)
    
    // Update registry with workflow metadata
    useWorkflowRegistry.getState().updateWorkflow(workflowId, {
      id: workflowId,
      name: workflow.name || 'Untitled Workflow',
      description: workflow.description || '',
      lastModified: new Date(),
      color: workflow.color || '#3972F6',
    })
    
    // If this is the active workflow, update workflow store
    const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId
    if (workflowId === activeWorkflowId && workflow.state) {
      logger.info(`Updating active workflow state from YJS for: ${workflowId}`)
      // Use setState to update the workflow state directly
      useWorkflowStore.setState({
        ...useWorkflowStore.getState(),
        blocks: workflow.state.blocks || {},
        edges: workflow.state.edges || [],
        loops: workflow.state.loops || {},
        isDeployed: workflow.state.isDeployed || false,
        deployedAt: workflow.state.deployedAt,
        lastSaved: Date.now(),
      })
    }
  }

  private handleWorkflowDelete(workflowId: string): void {
    logger.info(`Handling YJS workflow deletion for: ${workflowId}`)
    
    // Update Zustand store by calling the removeWorkflow method
    useWorkflowRegistry.getState().removeWorkflow(workflowId)
    
    // If this was the active workflow, clear workflow store
    const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId
    if (workflowId === activeWorkflowId) {
      useWorkflowStore.getState().clear()
    }
  }

  private handleActiveWorkflowUpdate(activeWorkflowId: string): void {
    logger.info(`Handling YJS active workflow change to: ${activeWorkflowId}`)
    
    // Set active workflow using the existing method
    useWorkflowRegistry.getState().setActiveWorkflow(activeWorkflowId)
    
    // Load workflow state if available
    const workflow = this.yWorkflows.get(activeWorkflowId)
    if (workflow && workflow.state) {
      logger.info(`Loading workflow state from YJS for: ${activeWorkflowId}`)
      // Use setState to update the workflow state directly
      useWorkflowStore.setState({
        ...useWorkflowStore.getState(),
        blocks: workflow.state.blocks || {},
        edges: workflow.state.edges || [],
        loops: workflow.state.loops || {},
        isDeployed: workflow.state.isDeployed || false,
        deployedAt: workflow.state.deployedAt,
        lastSaved: Date.now(),
      })
    } else {
      logger.warn(`No workflow state found in YJS for: ${activeWorkflowId}`)
    }
  }

  private async syncToDatabase(): Promise<void> {
    if (!this.isInitialized) return;
    
    try {
      const workflows = Object.fromEntries(this.yWorkflows.entries())
      
      // Don't sync empty state to database
      if (Object.keys(workflows).length === 0) {
        logger.warn('Prevented sync of empty YJS state to database')
        return;
      }
      
      // Process workflows to ensure they have the correct structure
      const processedWorkflows: Record<string, any> = {};
      
      Object.entries(workflows).forEach(([id, workflow]) => {
        if (!workflow) return;
        
        // Ensure the workflow has the required structure for the API
        processedWorkflows[id] = {
          id,
          name: workflow.name || 'Untitled Workflow',
          description: workflow.description || '',
          color: workflow.color || '#3972F6',
          state: {
            blocks: (workflow.state && workflow.state.blocks) || {},
            edges: (workflow.state && workflow.state.edges) || [],
            loops: (workflow.state && workflow.state.loops) || {},
            isDeployed: (workflow.state && workflow.state.isDeployed) || false,
            deployedAt: (workflow.state && workflow.state.deployedAt) || null,
            lastSaved: Date.now()
          }
        };
      });
      
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

  // Public methods for components to use
  updateWorkflow(workflowId: string, workflow: any): void {
    // Skip update if it's from YJS itself
    if (updatingFromYjs) return;
    
    // Temporary ignore YJS updates to prevent loops
    this.ignoreLocalChanges = true;
    
    try {
      logger.info(`Updating YJS with workflow: ${workflowId}`);
      
      // Ensure we have all required fields to prevent sync issues
      const workflowData = {
        id: workflowId,
        name: workflow.name || 'Untitled Workflow',
        description: workflow.description || '',
        color: workflow.color || '#3972F6',
        state: {
          blocks: (workflow.state && workflow.state.blocks) || {},
          edges: (workflow.state && workflow.state.edges) || [],
          loops: (workflow.state && workflow.state.loops) || {},
          isDeployed: (workflow.state && workflow.state.isDeployed) || false,
          deployedAt: (workflow.state && workflow.state.deployedAt) || null,
          lastSaved: Date.now()
        }
      };
      
      this.yWorkflows.set(workflowId, workflowData);
      
      // Trigger a database sync after updating YJS
      this.debouncedSync();
    } finally {
      // Restore normal operation
      setTimeout(() => {
        this.ignoreLocalChanges = false;
      }, 50);
    }
  }

  deleteWorkflow(workflowId: string): void {
    // Skip update if it's from YJS itself
    if (updatingFromYjs) return;
    
    // Temporary ignore YJS updates to prevent loops
    this.ignoreLocalChanges = true;
    
    try {
      logger.info(`Deleting workflow from YJS: ${workflowId}`)
      this.yWorkflows.delete(workflowId)
      
      // Trigger a database sync after deleting from YJS
      this.debouncedSync();
    } finally {
      // Restore normal operation
      setTimeout(() => {
        this.ignoreLocalChanges = false;
      }, 50);
    }
  }

  setActiveWorkflow(workflowId: string): void {
    // Skip update if it's from YJS itself
    if (updatingFromYjs) return;
    
    // Temporary ignore YJS updates to prevent loops
    this.ignoreLocalChanges = true;
    
    try {
      logger.info(`Setting active workflow in YJS: ${workflowId}`)
      this.yActiveWorkflow.set('id', workflowId)
    } finally {
      // Restore normal operation
      setTimeout(() => {
        this.ignoreLocalChanges = false;
      }, 50);
    }
  }

  dispose(): void {
    // Use proper cast to access the cancel method
    (this.debouncedSync as any).cancel();
  }

  // Mark binding as initialized and ready to react to changes
  markInitialized(): void {
    // Sync state to YJS when marked as initialized
    this.syncStateToYJS();
  }
  
  // Sync current state to YJS doc
  syncStateToYJS(): void {
    const registry = useWorkflowRegistry.getState();
    const workflows = registry.workflows;
    const activeId = registry.activeWorkflowId;
    
    if (Object.keys(workflows).length === 0) {
      logger.warn('No workflows to sync to YJS, skipping initial sync');
      return;
    }
    
    logger.info(`Syncing ${Object.keys(workflows).length} workflows to YJS`);
    
    // Temporary ignore YJS updates to prevent loops
    this.ignoreLocalChanges = true;
    
    try {
      // Update YJS with current workflows
      Object.entries(workflows).forEach(([id, metadata]) => {
        // Get full workflow with state
        const state = id === activeId 
          ? useWorkflowStore.getState() 
          : { blocks: {}, edges: [], loops: {} };
        
        const workflowData = {
          id,
          name: metadata.name || 'Untitled Workflow',
          description: metadata.description || '',
          color: metadata.color || '#3972F6',
          state: {
            blocks: state.blocks || {},
            edges: state.edges || [],
            loops: state.loops || {},
            lastSaved: Date.now(),
          }
        };
        
        // Update YJS document
        this.yWorkflows.set(id, workflowData);
        logger.info(`Synced workflow to YJS: ${id}`);
      });
      
      // Set active workflow
      if (activeId) {
        this.yActiveWorkflow.set('id', activeId);
        logger.info(`Set active workflow in YJS: ${activeId}`);
      }
      
      // Trigger database sync after updating YJS
      this.debouncedSync();
    } finally {
      // Restore normal operation after a small delay
      setTimeout(() => {
        this.ignoreLocalChanges = false;
      }, 100);
    }
  }

  // Check if updates are coming from YJS
  static isUpdatingFromYjs(): boolean {
    return updatingFromYjs;
  }
} 