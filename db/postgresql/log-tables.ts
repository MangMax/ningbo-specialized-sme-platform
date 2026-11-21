import { bigint, PgSchema, text } from 'drizzle-orm/pg-core'

export function postgresLogTables(schemaName = 'runtime_logs') {
  // Keep table names qualified even when the configured schema is public.
  const schema = new PgSchema(schemaName)
  const int64 = (name: string) => bigint(name, { mode: 'bigint' })
  return {
    policy: schema.table('log_policy', {
      id: int64('id').primaryKey(),
      retentionDays: int64('retentionDays').notNull(),
      maxBytes: int64('maxBytes').notNull(),
      logicalBytes: int64('logical_bytes').notNull(),
      pruned: int64('pruned').notNull(),
      cleared: int64('cleared').notNull(),
    }),
    collection: schema.table('log_collection', {
      id: int64('id').primaryKey(),
      collection: text('collection').notNull(),
      revision: int64('revision').notNull(),
    }),
    events: schema.table('log_events', {
      seq: int64('seq').primaryKey().generatedByDefaultAsIdentity(),
      id: text('id').notNull().unique(),
      timestamp: text('timestamp').notNull(),
      level: text('level').notNull(),
      source: text('source').notNull(),
      module: text('module'),
      operation: text('operation').notNull(),
      outcome: text('outcome').notNull(),
      requestId: text('requestId'),
      traceId: text('traceId'),
      taskId: text('taskId'),
      fileId: int64('fileId'),
      batchId: text('batchId'),
      resourceId: text('resourceId'),
      summary: text('summary').notNull(),
      detail: text('detail').notNull(),
    }),
  }
}
