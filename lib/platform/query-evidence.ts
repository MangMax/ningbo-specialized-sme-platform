/** Original public collection-envelope gate, shared without normalizing the command. */
import { isDeepStrictEqual } from 'node:util'
import { normalizeUscc } from '../../layers/sme-roster/lib/domain'
import type { RosterImportPlatformQuery } from '../roster-import-client'
import { archiveQueryKey, platformEvidenceError, PLATFORM_PERSISTED_SOURCE, recognizedEvidenceError, recognizedStoredStatus, RDJB_TITLE_CODES } from './recognized-evidence'
export function queryEvidenceError(query: RosterImportPlatformQuery, originalSource: unknown, owners: {
  byId(id: number): { usccNorm: string | null } | null | undefined
  byUscc(raw: unknown): unknown
}): string | null {
  if ((query.interface === 'recognized_list' && query.reuseExisting !== true) || query.collectionEvidence != null) {
    const evidence = query.collectionEvidence
    let message = query.interface === 'recognized_list' ? recognizedEvidenceError(evidence) : platformEvidenceError(evidence)
    if (!message && evidence) {
      if (query.interface !== PLATFORM_PERSISTED_SOURCE[evidence.source]) message = 'Collection source must match persisted interface'
      const key = evidence.effectiveConditions.uscc ?? (evidence.effectiveConditions.name ? `name:${evidence.effectiveConditions.name}` : null)
      const expectedTitle = evidence.titleScope.rdjb.length === 1 ? RDJB_TITLE_CODES[evidence.titleScope.rdjb[0]!] : null
      if ((key !== null && query.queryKey !== key) || ((evidence.rawData || evidence.dataRows) && query.queryKey !== archiveQueryKey(evidence)) || query.queriedAt !== evidence.queriedAt || (query.rdjb ?? '') !== evidence.titleScope.rdjb.join(',') || ((!originalSource || Object.hasOwn(query, 'titleCode')) && (query.titleCode ?? null) !== expectedTitle) || ((!originalSource || Object.hasOwn(query, 'status')) && query.status !== recognizedStoredStatus(evidence))) message = 'Query identity/status/title must match original collectionEvidence'
      const relations = Array.isArray(query.relations) ? query.relations : []
      if (query.relations != null && !Array.isArray(query.relations)) message = 'relations must be an array preserving original rows'
      if ((!originalSource || Object.hasOwn(query, 'relations')) && relations.length !== evidence.rows.length) message = 'Every original source row must have exactly one relation'
      for (const [i, relation] of relations.entries()) {
        const raw = evidence.rows[i]
        const selectedRaw = evidence.dataRows ? evidence.dataRows[i] : evidence.rawData ? evidence.rawData.rows[i] : raw
        if (query.interface === 'recognized_list' && ['aliasNameRaw', 'province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'].some(field => relation?.[field as keyof typeof relation] != null)) message = 'Recognized maintenance/recognition/region fields must retain their original meanings in rawFields, not legacy normalized columns'
        if (!relation || !raw || relation.sequenceNo !== i + 1 || !isDeepStrictEqual(relation.rawFields, selectedRaw) || (relation.relationKey ?? null) !== (raw.id ?? null) || (relation.nameRaw ?? null) !== (raw.qymc ?? null) || (relation.usccRaw ?? null) !== (raw.tyshxydm ?? null)) { message = 'Relation sequence/raw fields/identity must match original page row'; continue }
        if (relation.enterpriseId != null) {
          const owner = owners.byId(relation.enterpriseId)
          if (!owner || !normalizeUscc(raw?.tyshxydm) || owner.usccNorm !== normalizeUscc(raw?.tyshxydm)) message = 'Explicit enterprise must match the original row USCC; names alone cannot confirm identity'
        }
        if (relation.matchBasis && !['uscc', 'none'].includes(relation.matchBasis)) message = 'Recognized-list identity requires exact USCC; other identity decisions use a separate explicit workflow'
        if (relation.verificationStatus === 'confirmed' && !owners.byUscc(relation.usccRaw)) message = 'Confirmed relation requires an existing exact-USCC enterprise'
      }
    }
    return message
  }
  return null
}
