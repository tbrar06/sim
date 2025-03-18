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
  preserveWorkflows: z.array(z.string()).optional(),
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
      const { workflows: clientWorkflows, preserveWorkflows } = SyncPayloadSchema.parse(body)
      
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
      
      // Create a set of workflow IDs that should be preserved
      const preserveSet = new Set<string>(preserveWorkflows || []);
      
      // Another safeguard: If client has significantly fewer workflows than DB
      // and we don't have explicit preserveWorkflows list, this is suspicious
      if (
        dbWorkflows.length > 3 && 
        Object.keys(clientWorkflows).length < dbWorkflows.length / 2 &&
        preserveSet.size === 0
      ) {
        logger.warn(`[${requestId}] Potential data loss detected: Client sent ${Object.keys(clientWorkflows).length} workflows, DB has ${dbWorkflows.length} workflows`)
        return NextResponse.json({ 
          error: 'Sync rejected due to suspicious workflow count reduction', 
          message: 'Client is attempting to remove too many workflows at once'
        }, { status: 409 })
      }

      const now = new Date()
      let transactionSuccess = false;
      
      // Use a transaction to ensure all operations succeed or fail together
      await db.transaction(async (tx) => {
        // Create a map of DB workflows for easier lookup
        const dbWorkflowMap = new Map(dbWorkflows.map((w) => [w.id, w]))
        const processedIds = new Set<string>()

        // Process client workflows
        for (const [id, clientWorkflow] of Object.entries(clientWorkflows)) {
          processedIds.add(id)
          const dbWorkflow = dbWorkflowMap.get(id)

          // Validate workflow data before processing
          if (!clientWorkflow || typeof clientWorkflow !== 'object') {
            logger.warn(`[${requestId}] Skipping invalid workflow data for ID ${id}`);
            continue;
          }
          
          // Ensure state data is properly structured
          let validatedState = clientWorkflow.state;
          
          if (!validatedState || typeof validatedState !== 'object') {
            validatedState = { blocks: {}, edges: [], loops: {} };
          } else {
            // Make sure we have blocks, edges, and loops
            if (!validatedState.blocks || typeof validatedState.blocks !== 'object') {
              validatedState.blocks = {};
            }
            
            if (!Array.isArray(validatedState.edges)) {
              validatedState.edges = [];
            }
            
            if (!validatedState.loops || typeof validatedState.loops !== 'object') {
              validatedState.loops = {};
            }
          }

          // Validate state - ensure blocks contain required fields
          if (Object.keys(validatedState.blocks).length > 0) {
            for (const [blockId, block] of Object.entries(validatedState.blocks)) {
              if (!block || typeof block !== 'object') {
                logger.warn(`[${requestId}] Fixing invalid block in workflow ${id}, block ${blockId}`);
                validatedState.blocks[blockId] = { id: blockId, type: 'unknown', name: 'Invalid Block' };
              }
            }
          }

          if (dbWorkflow) {
            // Update existing workflow
            await tx
              .update(workflow)
              .set({
                name: clientWorkflow.name || dbWorkflow.name,
                description: clientWorkflow.description || dbWorkflow.description,
                color: clientWorkflow.color || dbWorkflow.color,
                state: validatedState,
                lastSynced: now,
                isDeployed: clientWorkflow.isDeployed ?? dbWorkflow.isDeployed,
                deployedAt: clientWorkflow.deployedAt || dbWorkflow.deployedAt,
                apiKey: clientWorkflow.apiKey || dbWorkflow.apiKey,
                updatedAt: now,
              })
              .where(eq(workflow.id, id))
            
            logger.info(`[${requestId}] Updated workflow ${id} in database`)
          } else {
            // Create new workflow
            await tx.insert(workflow).values({
              id,
              userId: session.user.id,
              name: clientWorkflow.name || 'Untitled Workflow',
              description: clientWorkflow.description || '',
              color: clientWorkflow.color || '#3972F6',
              state: validatedState,
              lastSynced: now,
              isDeployed: clientWorkflow.isDeployed || false,
              deployedAt: clientWorkflow.deployedAt || null,
              apiKey: clientWorkflow.apiKey || null,
              createdAt: now,
              updatedAt: now,
              collaborators: [],
            })
            
            logger.info(`[${requestId}] Created new workflow ${id} in database`)
          }
        }

        // Delete workflows that exist in DB but not in client
        // taking into account preserveWorkflows list
        let deleteCount = 0;
        for (const [id, dbWorkflow] of dbWorkflowMap.entries()) {
          if (!processedIds.has(id) && !preserveSet.has(id)) {
            await tx.delete(workflow).where(eq(workflow.id, id))
            deleteCount++;
          }
        }
        
        if (deleteCount > 0) {
          logger.info(`[${requestId}] Removed ${deleteCount} workflows from database`)
        }
        
        // Check for preserved workflows that were not in the client payload
        if (preserveSet.size > 0) {
          const preservedButNotSent = [...preserveSet].filter(id => !processedIds.has(id));
          if (preservedButNotSent.length > 0) {
            logger.info(`[${requestId}] Preserved ${preservedButNotSent.length} workflows that were not in client payload: ${preservedButNotSent.join(', ')}`)
          }
        }
        
        transactionSuccess = true;
      });

      logger.info(`[${requestId}] Successfully synced ${Object.keys(clientWorkflows).length} workflows`)
      return NextResponse.json({ 
        success: true, 
        timestamp: now.getTime(),
        message: `Successfully synced ${Object.keys(clientWorkflows).length} workflows`
      })
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error(`[${requestId}] Validation error:`, error)
        return NextResponse.json({ error: 'Invalid request body', details: error.format() }, { status: 400 })
      }
      throw error; // Re-throw for the outer catch block
    }
  } catch (error) {
    logger.error(`[${requestId}] Error syncing workflows:`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
