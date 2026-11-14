/** Offline-only frozen stage dependency from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** #732 A additive explicit 71609 registry. Ordinary/earlier catalogs stay unchanged. */
import { customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { platformBusinessObservation } from '../target-schema'
import { platformArchiveValue } from '../legacy-schema'
import { recognizedProjectionFields } from '../legacy-schema'
const cell = customType<{ data: unknown; driverData: unknown }>({ dataType: () => 'blob' })
export const recognizedStoredColumns = ['exact_title_raw', 'exact_title_state', 'exact_title_origin', 'exact_title_archive_id', 'exact_title_sha256'] as const
function exactFields() { return {
  exactTitleRaw: cell('exact_title_raw'),
  exactTitleState: text('exact_title_state', { enum: ['captured', 'uncaptured'] }),
  exactTitleOrigin: text('exact_title_origin', { enum: ['legacyRowSnapshot', 'commandInput'] }),
  exactTitleArchiveId: integer('exact_title_archive_id').references(()=>platformArchiveValue.id,{onDelete:'restrict'}), exactTitleSha256: text('exact_title_sha256'),
} }
export const recognizedStoredProjection = sqliteTable('platform_recognized_projection', {id:integer('id').primaryKey(),observationId:integer('observation_id'),...exactFields()})
export const storedRecognizedProjection = sqliteTable('platform_recognized_projection', {
  ...recognizedProjectionFields(()=>platformBusinessObservation.id),
  ...exactFields(),
})
