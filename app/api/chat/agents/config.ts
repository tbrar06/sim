import { WorkflowActions } from './types'

export const workflowActions: WorkflowActions = {
  addBlock: {
    description: 'Add one new block to the workflow',
    parameters: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['agent', 'api', 'condition', 'function', 'router'],
          description: 'The type of block to add',
        },
        name: {
          type: 'string',
          description:
            'Optional custom name for the block. Do not provide a name unless the user has specified it.',
        },
        position: {
          type: 'object',
          description:
            'Optional position for the block. Do not provide a position unless the user has specified it.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      },
    },
  },
  addEdge: {
    description: 'Create a connection (edge) between two blocks',
    parameters: {
      type: 'object',
      required: ['sourceId', 'targetId'],
      properties: {
        sourceId: {
          type: 'string',
          description: 'ID of the source block',
        },
        targetId: {
          type: 'string',
          description: 'ID of the target block',
        },
        sourceHandle: {
          type: 'string',
          description: 'Optional handle identifier for the source connection point',
        },
        targetHandle: {
          type: 'string',
          description: 'Optional handle identifier for the target connection point',
        },
      },
    },
  },
  removeBlock: {
    description: 'Remove a block from the workflow',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'ID of the block to remove' },
      },
    },
  },
  removeEdge: {
    description: 'Remove a connection (edge) between blocks',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'ID of the edge to remove' },
      },
    },
  },
}
