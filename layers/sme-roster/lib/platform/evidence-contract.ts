/** Shared evidence wire contract; neither reader imports the other for constants. */
export const MAX_EVIDENCE_CHUNK_BYTES = 65536
export const MAX_FULL_QUERY_BYTES = 4 * 1024 * 1024
export const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024
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
