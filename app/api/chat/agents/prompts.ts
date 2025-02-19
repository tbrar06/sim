import { WorkflowState } from '@/stores/workflow/types'

// System prompt that references workflow state
export const getSystemPrompt = (workflowState: any) => {
  const blockCount = Object.keys(workflowState.blocks).length
  const edgeCount = workflowState.edges.length

  // Create a summary of existing blocks
  const blockSummary = Object.values(workflowState.blocks)
    .map((block: any) => `- ${block.type} block named "${block.name}" with id ${block.id}`)
    .join('\n')

  // Create a summary of existing edges
  const edgeSummary = workflowState.edges
    .map((edge: any) => `- ${edge.source} -> ${edge.target} with id ${edge.id}`)
    .join('\n')

  return `You are a workflow assistant that helps users modify their workflow by adding/removing blocks and connections.

Current Workflow State:
${
  blockCount === 0
    ? 'The workflow is empty.'
    : `${blockSummary}

Connections:
${edgeCount === 0 ? 'No connections between blocks.' : edgeSummary}`
}

When users request changes:
- Consider existing blocks when suggesting connections
- Provide clear feedback about what actions you've taken

Use the following functions to modify the workflow:
1. Use the addBlock function to create a new block
2. Use the addEdge function to connect one block to another
3. Use the removeBlock function to remove a block
4. Use the removeEdge function to remove a connection

Only use the provided functions and respond naturally to the user's requests.`
}
