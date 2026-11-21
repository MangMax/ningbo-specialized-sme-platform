import { boolean, text, uuid } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'
import { JOB_STATES } from '../../layers/core/lib/job'

export const job = businessSchema.table('job', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  params: text('params').notNull(),
  state: text('state', { enum: JOB_STATES }).notNull().default('queued'),
  progress: text('progress').notNull().default('{"done":0,"total":1}'),
  result: text('result'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  claimToken: uuid('claim_token').defaultRandom(),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  requestKey: text('request_key'),
  inputSnapshot: text('input_snapshot'),
})
