import { Agent } from './agent'
import { PlanningAgentInput, PlanningResult } from './types'

export class PlanningAgent extends Agent {
  async process(input: PlanningAgentInput): Promise<PlanningResult> {
    const systemPrompt = `You are a workflow planning agent. Your job is to:
1. Analyze the user's request
2. Break it down into a series of workflow actions
3. Return these as a comma-separated list of required blocks

Example:
User: "I want to call an llm and GET from www.jina.com"
You should respond: "agent, api"

Only return the comma-separated list, nothing else.`

    const completion = await this.createCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.query },
    ])

    const requiredBlocks = completion.choices[0].message.content?.trim().split(',') || []

    return {
      requiredBlocks: requiredBlocks.map((block) => block.trim()),
      originalQuery: input.query,
    }
  }
}
