import { WorkflowState } from '@/stores/workflow/types'
import { Agent } from './agent'
import { workflowActions } from './config'
import { getSystemPrompt } from './prompts'
import { AgentResponse, WorkflowAgentInput } from './types'

export class WorkflowAgent extends Agent {
  async process(input: WorkflowAgentInput): Promise<AgentResponse> {
    const { planningResult, workflowState } = input

    const completion = await this.createCompletion(
      [
        { role: 'system', content: getSystemPrompt(workflowState as WorkflowState) },
        {
          role: 'user',
          content: `Create the following blocks for this request: ${planningResult.requiredBlocks.join(
            ', '
          )}. Original request: ${planningResult.originalQuery}`,
        },
      ],
      Object.entries(workflowActions).map(([name, config]) => ({
        type: 'function',
        function: {
          name,
          description: config.description,
          parameters: config.parameters,
        },
      }))
    )

    const message = completion.choices[0].message

    if (!message.tool_calls) {
      return {
        message: message.content || 'No actions to perform',
        actions: [],
      }
    }

    const actions = message.tool_calls.map((call) => ({
      name: call.function.name,
      parameters: JSON.parse(call.function.arguments),
    }))

    return {
      message: message.content || "I've updated the workflow based on your request.",
      actions,
    }
  }
}
