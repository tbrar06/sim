import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

export interface WorkflowState {
  blocks: Record<string, any>
  edges: any[]
}

export interface WorkflowAction {
  name: string
  parameters: Record<string, any>
}

export interface PlanningResult {
  requiredBlocks: string[]
  originalQuery: string
}

export interface AgentResponse {
  message: string
  actions: WorkflowAction[]
}

export interface BaseAgentInput {
  messages: ChatCompletionMessageParam[]
  workflowState: WorkflowState
}

export interface PlanningAgentInput {
  query: string
  workflowState: WorkflowState
}

export interface WorkflowAgentInput {
  planningResult: PlanningResult
  workflowState: WorkflowState
}

export interface WorkflowActionConfig {
  description: string
  parameters: {
    type: string
    required: string[]
    properties: Record<string, any>
  }
}

export interface WorkflowActions {
  [key: string]: WorkflowActionConfig
}
