import { integer, primaryKey, text } from 'drizzle-orm/pg-core'
import { businessSchema } from '../../../../db/postgresql/business-schema'
import { job } from '../../../../db/postgresql/job-tables'

export const platformBatchSegment = businessSchema.table('platform_batch_segment', {
  jobId: text('job_id').notNull().references(() => job.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  payload: text('payload').notNull(),
}, table => [primaryKey({ columns: [table.jobId, table.itemId, table.segmentIndex] })])
