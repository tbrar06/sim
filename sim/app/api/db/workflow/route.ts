import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console-logger'
import { db } from '@/db'
import { workflow } from '@/db/schema'

const logger = createLogger('Workflow API')

// Schema for workflow data
const WorkflowStateSchema = z.object({
  blocks: z.record(z.any()),
  edges: z.array(z.any()),
  loops: z.record(z.any()),
  lastSaved: z.number().optional(),
  isDeployed: z.boolean().optional(),
  deployedAt: z
    .union([z.string(), z.date()])
    .optional()
    .transform((val) => (typeof val === 'string' ? new Date(val) : val)),
})

const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  color: z.string().optional(),
  state: WorkflowStateSchema,
})

// Schema for sync payload
const SyncPayloadSchema = z.object({
  workflows: z.record(z.any()),
})

export async function GET() {
  const requestId = crypto.randomUUID().slice(0, 8)

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow fetch attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get all workflows for the user from the database
    const dbWorkflows = await db
      .select()
      .from(workflow)
      .where(eq(workflow.userId, session.user.id))

    // Convert to the format expected by the client
    const workflows = dbWorkflows.reduce((acc, w) => {
      acc[w.id] = {
        id: w.id,
        name: w.name,
        description: w.description || '',
        color: w.color || '#3972F6',
        state: w.state,
        lastSynced: w.lastSynced,
        isDeployed: w.isDeployed,
        deployedAt: w.deployedAt,
        apiKey: w.apiKey,
        createdAt: w.createdAt,
      }
      return acc
    }, {} as Record<string, any>)

    logger.info(`[${requestId}] Fetched ${Object.keys(workflows).length} workflows for user ${session.user.id}`)
    return NextResponse.json({ workflows })
  } catch (error) {
    logger.error(`[${requestId}] Error fetching workflows:`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8)

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow sync attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()

    try {
      const { workflows: clientWorkflows } = SyncPayloadSchema.parse(body)
      
      // Get existing workflows for comparison
      const dbWorkflows = await db
        .select()
        .from(workflow)
        .where(eq(workflow.userId, session.user.id))
      
      // Log the sync attempt for debugging
      logger.info(`[${requestId}] Sync attempt: Client has ${Object.keys(clientWorkflows).length} workflows, DB has ${dbWorkflows.length} workflows`)

      // CRITICAL SAFEGUARD: Prevent wiping out existing workflows
      // This check prevents empty state syncs that would erase data
      if (Object.keys(clientWorkflows).length === 0 && dbWorkflows.length > 0) {
        logger.warn(`[${requestId}] Prevented data loss: Client attempted to sync empty workflows while DB has ${dbWorkflows.length} workflows`)
        return NextResponse.json({ 
          error: 'Sync rejected to prevent data loss', 
          message: 'Client sent empty workflows, but user has existing workflows in database'
        }, { status: 409 })
      }
      
      // Another safeguard: If client has significantly fewer workflows than DB
      // and we've previously received a sync with more workflows, this is suspicious
      if (dbWorkflows.length > 3 && Object.keys(clientWorkflows).length < dbWorkflows.length / 2) {
        logger.warn(`[${requestId}] Potential data loss detected: Client sent ${Object.keys(clientWorkflows).length} workflows, DB has ${dbWorkflows.length} workflows`)
        return NextResponse.json({ 
          error: 'Sync rejected due to suspicious workflow count reduction', 
          message: 'Client is attempting to remove too many workflows at once'
        }, { status: 409 })
      }

      const now = new Date()
      const operations: Promise<any>[] = []

      // Create a map of DB workflows for easier lookup
      const dbWorkflowMap = new Map(dbWorkflows.map((w) => [w.id, w]))
      const processedIds = new Set<string>()

      // Process client workflows
      for (const [id, clientWorkflow] of Object.entries(clientWorkflows)) {
        processedIds.add(id)
        const dbWorkflow = dbWorkflowMap.get(id)

        if (dbWorkflow) {
          // Update existing workflow
          operations.push(
            db
              .update(workflow)
              .set({
                name: clientWorkflow.name,
                description: clientWorkflow.description,
                color: clientWorkflow.color,
                state: clientWorkflow.state,
                lastSynced: now,
                isDeployed: clientWorkflow.isDeployed,
                deployedAt: clientWorkflow.deployedAt,
                apiKey: clientWorkflow.apiKey,
              })
              .where(eq(workflow.id, id))
          )
        } else {
          // Create new workflow
          operations.push(
            db.insert(workflow).values({
              id,
              userId: session.user.id,
              name: clientWorkflow.name,
              description: clientWorkflow.description,
              color: clientWorkflow.color,
              state: clientWorkflow.state,
              lastSynced: now,
              isDeployed: clientWorkflow.isDeployed,
              deployedAt: clientWorkflow.deployedAt,
              apiKey: clientWorkflow.apiKey,
              createdAt: now,
              updatedAt: now,
            })
          )
        }
      }

      // Delete workflows that no longer exist in client state
      for (const [id, dbWorkflow] of dbWorkflowMap.entries()) {
        if (!processedIds.has(id)) {
          operations.push(
            db.delete(workflow).where(eq(workflow.id, id))
          )
        }
      }

      // Execute all operations
      await Promise.all(operations)

      logger.info(`[${requestId}] Successfully synced ${Object.keys(clientWorkflows).length} workflows`)
      return NextResponse.json({ success: true })
    } catch (error) {
      logger.error(`[${requestId}] Validation error:`, error)
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
  } catch (error) {
    logger.error(`[${requestId}] Error syncing workflows:`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
