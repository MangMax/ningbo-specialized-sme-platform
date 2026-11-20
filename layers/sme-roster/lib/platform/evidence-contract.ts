/** Shared evidence wire contract; neither reader imports the other for constants. */
export const MAX_EVIDENCE_CHUNK_BYTES = 65536
export const MAX_FULL_QUERY_BYTES = 4 * 1024 * 1024
export const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024
export function assertPlatformFullReadBudget(budget: readonly number[]) {
  if (budget.some(n => n > MAX_FULL_QUERY_BYTES) || budget.reduce((sum, bytes) => sum + bytes, 0) > MAX_FULL_PAGE_BYTES) {
    const message = 'Platform evidence exceeds full-read budget; use view=summary and /api/platform/queries/{queryId}/evidence (get_platform_query_evidence)'
    throw Object.assign(new Error(message), { statusCode: 413, statusMessage: message })
  }
}
export const PROVENANCE_CELL_NAMES = [
  'query_id', 'source_identity', 'source_sha256', 'segment_index', 'collection', 'input_fingerprint', 'import_batch_id', 'created_at',
] as const
export interface PlatformEvidenceInput {
  queryId: number
  field: 'rawResponse' | 'collectionEvidence' | 'legacyProvenance' | 'relations' | 'relation'
  relationId?: number
  offset?: number
  length?: number
  page?: number
  pageSize?: number
}
export type PlatformEvidenceResult = {
  queryId: number; field: PlatformEvidenceInput['field']; total: number; page: number; pageSize: number
  rows: { id: number; sequenceNo: number }[]
} | {
  queryId: number; field: PlatformEvidenceInput['field']; relationId?: number
  encoding: 'base64'; offset: number; byteLength: number; totalBytes: number
  isNull: boolean; hasMore: boolean; data: string
}
