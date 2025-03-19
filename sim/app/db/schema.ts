import { boolean, json, pgTable, text, timestamp, uniqueIndex, integer } from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
})

export const workflow = pgTable('workflow', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  state: json('state').notNull(),
  color: text('color').notNull().default('#3972F6'),
  lastSynced: timestamp('last_synced').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  isDeployed: boolean('is_deployed').notNull().default(false),
  deployedAt: timestamp('deployed_at'),
  apiKey: text('api_key'),
  collaborators: json('collaborators').notNull().default('[]'),
})

export const waitlist = pgTable('waitlist', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  status: text('status').notNull().default('pending'), // pending, approved, rejected
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const workflowLogs = pgTable('workflow_logs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflow.id, { onDelete: 'cascade' }),
  executionId: text('execution_id'),
  level: text('level').notNull(), // e.g. "info", "error", etc.
  message: text('message').notNull(),
  duration: text('duration'), // Store as text to allow 'NA' for errors
  trigger: text('trigger'), // e.g. "api", "schedule", "manual"
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: json('metadata'), // Optional JSON field for storing additional context like tool calls
})

export const environment = pgTable('environment', {
  id: text('id').primaryKey(), // Use the user id as the key
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
    .unique(), // One environment per user
  variables: json('variables').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const settings = pgTable('settings', {
  id: text('id').primaryKey(), // Use the user id as the key
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
    .unique(), // One settings record per user
  general: json('general').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const workflowSchedule = pgTable('workflow_schedule', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflow.id, { onDelete: 'cascade' })
    .unique(),
  cronExpression: text('cron_expression'),
  nextRunAt: timestamp('next_run_at'),
  lastRanAt: timestamp('last_ran_at'),
  triggerType: text('trigger_type').notNull(), // "manual", "webhook", "schedule"
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const webhook = pgTable(
  'webhook',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    provider: text('provider'), // e.g., "whatsapp", "github", etc.
    providerConfig: json('provider_config'), // Store provider-specific configuration
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => {
    return {
      // Ensure webhook paths are unique
      pathIdx: uniqueIndex('path_idx').on(table.path),
    }
  }
)

export const apiKey = pgTable('api_key', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  lastUsed: timestamp('last_used'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
})

// Marketplace tables
export const marketplace = pgTable('marketplace', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflow.id, { onDelete: 'cascade' }),
  state: json('state').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  authorId: text('author_id')
    .notNull()
    .references(() => user.id),
  authorName: text('author_name').notNull(),
  stars: integer('stars').notNull().default(0),
  executions: integer('executions').notNull().default(0),
  category: text('category'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// For tracking individual stars
export const marketplaceStar = pgTable('marketplace_star', {
  id: text('id').primaryKey(),
  marketplaceId: text('marketplace_id')
    .notNull()
    .references(() => marketplace.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => {
  return {
    userMarketplaceIdx: uniqueIndex('user_marketplace_idx').on(table.userId, table.marketplaceId),
  }
})

// For tracking executions
export const marketplaceExecution = pgTable('marketplace_execution', {
  id: text('id').primaryKey(),
  marketplaceId: text('marketplace_id')
    .notNull()
    .references(() => marketplace.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .references(() => user.id), // Optional, for anonymous executions
  createdAt: timestamp('created_at').notNull().defaultNow(),
})