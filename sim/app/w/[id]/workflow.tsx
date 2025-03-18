'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import ReactFlow, {
  Background,
  ConnectionLineType,
  EdgeTypes,
  NodeTypes,
  ReactFlowProvider,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { createLogger } from '@/lib/logs/console-logger'
import { useGeneralStore } from '@/stores/settings/general/store'
import { getYjsBinding, initializeSyncManagers, isSyncInitialized } from '@/stores/sync-registry'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { NotificationList } from '@/app/w/[id]/components/notifications/notifications'
import { getBlock } from '@/blocks'
import { ErrorBoundary } from './components/error/index'
import { WorkflowBlock } from './components/workflow-block/workflow-block'
import { WorkflowEdge } from './components/workflow-edge/workflow-edge'
import { LoopInput } from './components/workflow-loop/components/loop-input/loop-input'
import { LoopLabel } from './components/workflow-loop/components/loop-label/loop-label'
import { createLoopNode, getRelativeLoopPosition } from './components/workflow-loop/workflow-loop'

const logger = createLogger('Workflow')

// Define custom node and edge types
const nodeTypes: NodeTypes = {
  workflowBlock: WorkflowBlock,
  loopLabel: LoopLabel,
  loopInput: LoopInput,
}
const edgeTypes: EdgeTypes = { workflowEdge: WorkflowEdge }

function WorkflowContent() {
  // State
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [isYjsInitialized, setIsYjsInitialized] = useState(false)
  const syncTimeRef = useRef<number>(0)

  // Hooks
  const params = useParams()
  const router = useRouter()
  const { project } = useReactFlow()
  const workflowId = params.id as string

  // Store access
  const { workflows, setActiveWorkflow, createWorkflow } = useWorkflowRegistry()
  const { blocks, edges, loops, addBlock, updateBlockPosition, addEdge, removeEdge } =
    useWorkflowStore()
  const { setValue: setSubBlockValue } = useSubBlockStore()

  // Initialize workflow
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Ensure sync system is initialized before proceeding
      const initSync = async () => {
        // Initialize sync system if not already initialized
        await initializeSyncManagers()
        setIsInitialized(true)
      }

      // Check if already initialized
      if (isSyncInitialized()) {
        setIsInitialized(true)
      } else {
        initSync()
      }
    }
  }, [])

  // Setup YJS for real-time collaboration
  useEffect(() => {
    if (!isInitialized || !workflowId) return

    let isMounted = true
    let retryCount = 0
    const maxRetries = 3

    const initializeCollaboration = async () => {
      try {
        // Get YJS binding
        const binding = getYjsBinding()
        if (!binding) {
          logger.warn('YJS binding not available for real-time collaboration')
          return
        }

        logger.info(`Initializing YJS collaboration for workflow: ${workflowId}`)

        // Initialize workflow-specific YJS
        const initSuccess = await binding.initializeWorkflow(workflowId)
        if (!initSuccess) {
          throw new Error(`Failed to initialize YJS for workflow: ${workflowId}`)
        }

        // Make this the active workflow
        await binding.setActiveWorkflow(workflowId)

        // Sync current state to YJS
        await binding.syncWorkflowToYJS(workflowId)

        // Update UI state if component still mounted
        if (isMounted) {
          setIsYjsInitialized(true)
          logger.info(
            `Successfully connected to real-time collaboration for workflow: ${workflowId}`
          )
        }
      } catch (error) {
        logger.error(`Error initializing collaboration for workflow ${workflowId}:`, error)

        // Implement retry with exponential backoff
        if (retryCount < maxRetries && isMounted) {
          const delay = Math.pow(2, retryCount) * 1000
          retryCount++
          logger.info(`Retrying YJS initialization (${retryCount}/${maxRetries}) in ${delay}ms...`)
          setTimeout(initializeCollaboration, delay)
        }
      }
    }

    // Initialize collaboration
    initializeCollaboration()

    // Cleanup function
    return () => {
      isMounted = false
      // Only clean up if we're changing workflows, not unmounting the component
      if (getYjsBinding()) {
        // We don't disconnect here - let the YJS binding manager handle that
        // to support persistence across navigation
      }

      setIsYjsInitialized(false)
    }
  }, [isInitialized, workflowId])

  // Hook to sync workflow changes to YJS
  useEffect(() => {
    if (!isYjsInitialized || !workflowId || !blocks) return

    // Skip redundant updates or updates during initialization
    if (Object.keys(blocks).length === 0) return

    // Only sync changes after initialization
    const yjsBinding = getYjsBinding()
    if (!yjsBinding) {
      logger.warn('Cannot sync to YJS: binding not available')
      return
    }

    const currentTime = Date.now()

    // Skip if we just synced very recently (debounce)
    if (currentTime - syncTimeRef.current < 500) {
      return
    }

    // Create a sync operation with proper error handling
    const syncToYJS = async () => {
      try {
        logger.info(`Syncing workflow state to YJS: ${workflowId}`)

        // Get latest state with deep cloning to prevent reference issues
        const currentState = {
          blocks: JSON.parse(JSON.stringify(blocks)),
          edges: JSON.parse(JSON.stringify(edges)),
          loops: JSON.parse(JSON.stringify(loops)),
          lastSaved: currentTime,
        }

        // Update YJS with the current workflow state
        await yjsBinding.updateWorkflowState(workflowId, currentState)

        // Track successful sync time
        syncTimeRef.current = currentTime
        logger.info(`Successfully synced workflow ${workflowId} to YJS`)
      } catch (error) {
        logger.error('Failed to sync workflow state to YJS:', error)
      }
    }

    // Use a slight delay to batch multiple rapid state changes
    const timerId = setTimeout(syncToYJS, 300)

    return () => clearTimeout(timerId)
  }, [isYjsInitialized, workflowId, blocks, edges, loops])

  // Init workflow on route/param change
  useEffect(() => {
    if (!isInitialized) return

    const validateAndNavigate = async () => {
      try {
        const workflowIds = Object.keys(workflows)
        const currentId = params.id as string

        // Handle empty workflow registry
        if (workflowIds.length === 0) {
          logger.info('No workflows found, creating initial workflow')
          const newId = createWorkflow({ isInitial: true })
          router.replace(`/w/${newId}`)
          return
        }

        // Handle invalid workflow ID
        if (!workflows[currentId]) {
          logger.info(`Invalid workflow ID: ${currentId}, redirecting to first available workflow`)
          router.replace(`/w/${workflowIds[0]}`)
          return
        }

        // Import the isActivelyLoadingFromDB function to check sync status
        const { isActivelyLoadingFromDB } = await import('@/stores/workflows/sync')

        // Wait for any active DB loading to complete before switching workflows
        if (isActivelyLoadingFromDB()) {
          logger.info('Waiting for DB loading to complete before switching workflow')

          // Poll until loading is complete
          let attempts = 0
          const maxAttempts = 50 // 5 seconds max wait

          const waitForLoading = () => {
            if (!isActivelyLoadingFromDB() || attempts >= maxAttempts) {
              setActiveWorkflow(currentId)
            } else {
              attempts++
              setTimeout(waitForLoading, 100)
            }
          }

          waitForLoading()
          return
        }

        // Activate the workflow
        logger.info(`Setting active workflow to: ${currentId}`)
        await setActiveWorkflow(currentId)
      } catch (error) {
        logger.error('Error during workflow initialization:', error)
      }
    }

    validateAndNavigate()
  }, [params.id, workflows, setActiveWorkflow, createWorkflow, router, isInitialized])

  // Transform blocks and loops into ReactFlow nodes
  const nodes = useMemo(() => {
    const nodeArray: any[] = []

    // Add loop group nodes and their labels
    Object.entries(loops).forEach(([loopId, loop]) => {
      const loopNodes = createLoopNode({ loopId, loop, blocks })
      if (loopNodes) {
        // Add both the loop node and its label node
        nodeArray.push(...loopNodes)
      }
    })

    // Add block nodes
    Object.entries(blocks).forEach(([blockId, block]) => {
      if (!block.type || !block.name) {
        logger.warn(`Skipping invalid block: ${blockId}`, { block })
        return
      }

      const blockConfig = getBlock(block.type)
      if (!blockConfig) {
        logger.error(`No configuration found for block type: ${block.type}`, { block })
        return
      }

      const parentLoop = Object.entries(loops).find(([_, loop]) => loop.nodes.includes(block.id))
      let position = block.position

      if (parentLoop) {
        const [loopId] = parentLoop
        const loopNode = nodeArray.find((node) => node.id === `loop-${loopId}`)
        if (loopNode) {
          position = getRelativeLoopPosition(block.position, loopNode.position)
        }
      }

      nodeArray.push({
        id: block.id,
        type: 'workflowBlock',
        position,
        parentId: parentLoop ? `loop-${parentLoop[0]}` : undefined,
        dragHandle: '.workflow-drag-handle',
        data: {
          type: block.type,
          config: blockConfig,
          name: block.name,
        },
      })
    })

    return nodeArray
  }, [blocks, loops])

  // Update nodes
  const onNodesChange = useCallback(
    (changes: any) => {
      changes.forEach((change: any) => {
        if (change.type === 'position' && change.position) {
          const node = nodes.find((n) => n.id === change.id)
          if (!node) return

          if (node.parentId) {
            const loopNode = nodes.find((n) => n.id === node.parentId)
            if (loopNode) {
              const absolutePosition = {
                x: change.position.x + loopNode.position.x,
                y: change.position.y + loopNode.position.y,
              }
              updateBlockPosition(change.id, absolutePosition)
            }
          } else {
            updateBlockPosition(change.id, change.position)
          }
        }
      })
    },
    [nodes, updateBlockPosition]
  )

  // Update edges
  const onEdgesChange = useCallback(
    (changes: any) => {
      changes.forEach((change: any) => {
        if (change.type === 'remove') {
          removeEdge(change.id)
        }
      })
    },
    [removeEdge]
  )

  // Handle connections
  const onConnect = useCallback(
    (connection: any) => {
      if (connection.source && connection.target) {
        addEdge({
          ...connection,
          id: crypto.randomUUID(),
          type: 'workflowEdge',
        })
      }
    },
    [addEdge]
  )

  // Handle drops
  const findClosestOutput = useCallback(
    (newNodePosition: { x: number; y: number }) => {
      const existingBlocks = Object.entries(blocks)
        .filter(([_, block]) => block.enabled && block.type !== 'condition')
        .map(([id, block]) => ({
          id,
          position: block.position,
          distance: Math.sqrt(
            Math.pow(block.position.x - newNodePosition.x, 2) +
              Math.pow(block.position.y - newNodePosition.y, 2)
          ),
        }))
        .sort((a, b) => a.distance - b.distance)

      return existingBlocks[0]?.id
    },
    [blocks]
  )

  // Update the onDrop handler
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      try {
        const data = JSON.parse(event.dataTransfer.getData('application/json'))
        if (data.type === 'connectionBlock') return

        const reactFlowBounds = event.currentTarget.getBoundingClientRect()
        const position = project({
          x: event.clientX - reactFlowBounds.left,
          y: event.clientY - reactFlowBounds.top,
        })

        const blockConfig = getBlock(data.type)
        if (!blockConfig) {
          logger.error('Invalid block type:', { data })
          return
        }

        const id = crypto.randomUUID()
        const name = `${blockConfig.name} ${
          Object.values(blocks).filter((b) => b.type === data.type).length + 1
        }`

        addBlock(id, data.type, name, position)

        // Auto-connect logic
        const isAutoConnectEnabled = useGeneralStore.getState().isAutoConnectEnabled
        if (isAutoConnectEnabled && data.type !== 'starter') {
          const closestBlockId = findClosestOutput(position)
          if (closestBlockId) {
            addEdge({
              id: crypto.randomUUID(),
              source: closestBlockId,
              target: id,
              sourceHandle: 'source',
              targetHandle: 'target',
              type: 'custom',
            })
          }
        }
      } catch (err) {
        logger.error('Error dropping block:', { err })
      }
    },
    [project, blocks, addBlock, addEdge, findClosestOutput]
  )

  // Update onPaneClick to only handle edge selection
  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
  }, [])

  // Edge selection
  const onEdgeClick = useCallback((event: React.MouseEvent, edge: any) => {
    setSelectedEdgeId(edge.id)
  }, [])

  // Transform edges to include selection state
  const edgesWithSelection = edges.map((edge) => ({
    ...edge,
    type: edge.type || 'workflowEdge',
    data: {
      selectedEdgeId,
      onDelete: (edgeId: string) => {
        removeEdge(edgeId)
        setSelectedEdgeId(null)
      },
    },
  }))

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) {
        removeEdge(selectedEdgeId)
        setSelectedEdgeId(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedEdgeId, removeEdge])

  // Handle sub-block value updates from custom events
  useEffect(() => {
    const handleSubBlockValueUpdate = (event: CustomEvent) => {
      const { blockId, subBlockId, value } = event.detail
      if (blockId && subBlockId) {
        setSubBlockValue(blockId, subBlockId, value)
      }
    }

    window.addEventListener('update-subblock-value', handleSubBlockValueUpdate as EventListener)

    return () => {
      window.removeEventListener(
        'update-subblock-value',
        handleSubBlockValueUpdate as EventListener
      )
    }
  }, [setSubBlockValue])

  // Add a listener for real-time updates
  useEffect(() => {
    if (!isYjsInitialized || !workflowId) return

    // Set up a periodic check for YJS updates to force re-render if needed
    // This ensures that if a change is missed in the normal flow, the UI will still update
    const checkInterval = setInterval(() => {
      const yjsBinding = getYjsBinding()
      if (!yjsBinding) return

      // Force a small state update to ensure the component re-renders
      // This is important to make sure all real-time changes are reflected
      useWorkflowStore.setState((state) => ({
        ...state,
        lastSaved: Date.now(),
      }))
    }, 2000)

    return () => {
      clearInterval(checkInterval)
    }
  }, [isYjsInitialized, workflowId])

  if (!isInitialized) return null

  return (
    <>
      <div className="relative w-full h-[calc(100vh-4rem)]">
        <NotificationList />
        <ReactFlow
          nodes={nodes}
          edges={edgesWithSelection}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          fitView
          minZoom={0.1}
          maxZoom={1}
          panOnScroll
          defaultEdgeOptions={{ type: 'custom' }}
          proOptions={{ hideAttribution: true }}
          connectionLineStyle={{
            stroke: '#94a3b8',
            strokeWidth: 2,
            strokeDasharray: '5,5',
          }}
          connectionLineType={ConnectionLineType.SmoothStep}
          onNodeClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onPaneClick={onPaneClick}
          onEdgeClick={onEdgeClick}
          elementsSelectable={true}
          selectNodesOnDrag={false}
          nodesConnectable={true}
          nodesDraggable={true}
          draggable={false}
          noWheelClassName="allow-scroll"
          edgesFocusable={true}
          edgesUpdatable={true}
        >
          <Background />
        </ReactFlow>
      </div>
    </>
  )
}

// Workflow wrapper
export default function Workflow() {
  return (
    <ReactFlowProvider>
      <ErrorBoundary>
        <WorkflowContent />
      </ErrorBoundary>
    </ReactFlowProvider>
  )
}
