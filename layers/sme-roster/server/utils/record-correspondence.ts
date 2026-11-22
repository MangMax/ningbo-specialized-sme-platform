import { type CorrespondenceRead, type StoredCorrespondence } from './record-correspondence-model'
export type CorrespondenceFilter = Partial<Pick<CorrespondenceRead, 'id' | 'eventId' | 'relationId' | 'exportRowId' | 'enterpriseId' | 'titleCode' | 'status' | 'type' | 'role' | 'ruleVersion'>> & { anyEventId?: number }
export interface CorrespondencePaging { page: number; pageSize: number }
export type CorrespondenceRefRow = Pick<StoredCorrespondence, 'id' | 'type' | 'role' | 'status' | 'eventId' | 'predecessorEventId' | 'relationId' | 'exportRowId' | 'enterpriseId' | 'titleCode' | 'revision'>
export { type CorrespondenceRead, type ReadSources, type SourceReference } from './record-correspondence-model'
