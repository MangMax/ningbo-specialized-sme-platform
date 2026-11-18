/** Offline-only frozen stage dependency from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** Explicit 71609 observation additions only; ordinary expand/71608 stay unchanged. */
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import * as s from '../legacy-schema'
import { CANDIDATE_SCOPE_RULE } from '../../layers/sme-roster/lib/platform/candidate-scope-capture'
export const candidateScopeColumns = [
  'candidate_scope_mask','candidate_scope_rule','candidate_scope_archive_id','candidate_scope_rdjb',
  'candidate_scope_title_code','candidate_scope_sequence_no','candidate_scope_error','candidate_scope_state',
] as const
export const candidateScopeCheck = `(candidate_scope_state IS 'uncaptured' AND candidate_scope_mask IS NULL AND candidate_scope_rule IS NULL AND candidate_scope_archive_id IS NULL AND candidate_scope_rdjb IS NULL AND candidate_scope_title_code IS NULL AND candidate_scope_sequence_no IS NULL AND typeof(candidate_scope_error)='text' AND length(candidate_scope_error)>0) OR
 (candidate_scope_state IN ('captured','error') AND candidate_scope_state IS NOT NULL AND candidate_scope_rule IS '${CANDIDATE_SCOPE_RULE}' AND typeof(candidate_scope_archive_id)='integer' AND candidate_scope_archive_id BETWEEN 1 AND 9007199254740991 AND typeof(candidate_scope_rdjb)='text' AND typeof(candidate_scope_title_code) IN ('null','text') AND typeof(candidate_scope_sequence_no)='integer' AND candidate_scope_sequence_no BETWEEN 1 AND 9007199254740991 AND
 ((candidate_scope_state IS 'captured' AND typeof(candidate_scope_mask)='integer' AND candidate_scope_mask BETWEEN 0 AND 7 AND candidate_scope_error IS NULL) OR
 (candidate_scope_state IS 'error' AND candidate_scope_mask IS NULL AND candidate_scope_error IN ('malformed JSON','integer overflow') AND candidate_scope_error IS NOT NULL)))`
export function candidateScopeFields() { return {
  candidateScopeMask: integer('candidate_scope_mask'),
  candidateScopeRule: text('candidate_scope_rule'),
  candidateScopeArchiveId: integer('candidate_scope_archive_id').references(() => s.platformArchiveValue.id, { onDelete: 'restrict' }),
  candidateScopeRdjb: text('candidate_scope_rdjb'),
  candidateScopeTitleCode: text('candidate_scope_title_code'),
  candidateScopeSequenceNo: integer('candidate_scope_sequence_no'),
  candidateScopeError: text('candidate_scope_error').default('not_captured'),
  candidateScopeState: text('candidate_scope_state', { enum: ['uncaptured','captured','error'] }).notNull().default('uncaptured'),
} }
export const candidateScopeObservation = sqliteTable('platform_business_observation', {
  id: integer('id').primaryKey(), collectionId: integer('collection_id').notNull(), sequenceNo: integer('sequence_no').notNull(),
  ...s.observationFields(), positionState: text('position_state', { enum: ['verified','unknown','conflict'] }).notNull(),
  applyExactOwnerId: integer('apply_exact_owner_id'), applyExactState: text('apply_exact_state', { enum: ['captured','uncaptured'] }),
  applySqlFactTitleState: text('apply_sql_fact_title_state', { enum: ['captured','uncaptured'] }),
  ...candidateScopeFields(),
}, () => [check('platform_candidate_scope_ck', sql.raw(candidateScopeCheck))])
