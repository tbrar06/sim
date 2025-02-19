import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PlanningAgent } from './agents/planningAgent'
import { WorkflowAgent } from './agents/workflowAgent'

// Validation schemas
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
})

// Request schema
const RequestSchema = z.object({
  messages: z.array(MessageSchema),
  workflowState: z.object({
    blocks: z.record(z.any()),
    edges: z.array(z.any()),
  }),
})

export async function POST(request: Request) {
  try {
    // Validate API key
    const apiKey = request.headers.get('X-OpenAI-Key')
    if (!apiKey) {
      return NextResponse.json({ error: 'OpenAI API key is required' }, { status: 401 })
    }

    // Parse and validate request body
    const body = await request.json()
    const validatedData = RequestSchema.parse(body)
    const { messages, workflowState } = validatedData

    // Get the latest user message
    const userMessage = messages[messages.length - 1].content

    // Initialize agents
    const planningAgent = new PlanningAgent(apiKey)
    const workflowAgent = new WorkflowAgent(apiKey)

    // Execute agent pipeline
    const planningResult = await planningAgent.process({
      query: userMessage,
      workflowState,
    })

    const workflowResult = await workflowAgent.process({
      planningResult,
      workflowState,
    })

    return NextResponse.json(workflowResult)
  } catch (error) {
    console.error('Chat API error:', error)

    // Handle specific error types
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request format', details: error.errors },
        { status: 400 }
      )
    }

    return NextResponse.json({ error: 'Failed to process chat message' }, { status: 500 })
  }
}
