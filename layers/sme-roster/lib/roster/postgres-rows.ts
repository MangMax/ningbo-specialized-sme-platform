import { getTableColumns, getTableName, sql, type Table } from 'drizzle-orm'
import { officialRawFieldColumns, postgresOfficialRawField } from '../../../../db/postgresql/official-evidence-tables'

// Existing plan and evidence digests depend on these JSON field sequences.
const orderedKeys: Readonly<Record<string, readonly string[]>> = {
  platform_business_observation: [
    'id', 'collectionId', 'sequenceNo', 'pageId', 'pageRowNo', 'positionState',
    'sourceRelationKey', 'recordId', 'versionId', 'identityState', 'contentState', 'keySource',
    'projectionRuleVersion', 'inputFingerprint', 'indexedAt', 'batchId', 'processExactOwnerId', 'processExactState',
    'processSqlFactTitleState', 'applyExactOwnerId', 'applyExactState', 'applySqlFactTitleState', 'candidateScopeMask', 'candidateScopeRule',
    'candidateScopeArchiveId', 'candidateScopeRdjb', 'candidateScopeTitleCode', 'candidateScopeSequenceNo', 'candidateScopeError', 'candidateScopeState',
    'witnessRule', 'witnessCollectionId', 'witnessSequenceNo', 'witnessArchiveId', 'witnessSha256', 'witnessOrdinal',
    'witnessRdjbKind', 'witnessRdjbValue', 'witnessRdjbKey', 'witnessPageKind', 'witnessPageValue', 'witnessErrorName',
    'witnessError', 'witnessState',
  ],
  platform_business_record_version: [
    'id', 'recordId', 'hashAlgorithm', 'contentHash', 'canonicalRawJson', 'canonicalArchiveId',
    'createdAt',
  ],
  platform_collection: [
    'id', 'interface', 'queryKey', 'rdjb', 'titleCode', 'queriedAt',
    'createdAt', 'lastCollectedAt', 'status', 'failureReason', 'source', 'evidenceStatus',
    'completedAt', 'completeness', 'fullRange', 'fetchedCount', 'declaredTotal', 'scopeMode',
    'provenanceState', 'parseState', 'ruleVersion', 'errorCode', 'errorMessage', 'maxRequests',
    'maxRows', 'maxDurationMs', 'pageSize', 'reconcileSlotState', 'reconcileSlotRule', 'reconcileSlotRawArchiveId',
    'reconcileSlotRowCount', 'reconcileSlotInputSha256', 'reconcileSlotReason', 'witnessState', 'witnessGate', 'witnessRule',
    'witnessArchiveId', 'witnessSha256', 'witnessErrorName', 'witnessError',
  ],
  platform_collection_page: [
    'id', 'collectionId', 'ordinal', 'source', 'rdjb', 'pageNo',
    'maxPage', 'maxPagePresent', 'fetchedCount', 'declaredTotal', 'status', 'errorCode',
    'errorMessage', 'sequenceStart', 'sequenceEnd', 'positionState',
  ],
  platform_export_row: [
    'id', 'batchId', 'sourceRowNo', 'usccRaw', 'nameRaw', 'district',
    'province', 'city', 'regStatus', 'rawFields', 'createdAt',
  ],
  platform_observation_assignment: [
    'observationId', 'revision', 'enterpriseId', 'matchBasis', 'verificationStatus', 'usccRaw',
    'nameRaw', 'aliasNameRaw', 'actor', 'basis', 'commandReceiptId', 'recordedAt',
    'origin',
  ],
  record_event: [
    'id', 'recordId', 'eventType', 'year', 'batchSeq', 'sortKey',
    'reviewOutcome', 'decidedYear', 'formalValidity', 'revision',
  ],
}
const jsonFields: Readonly<Record<string, readonly string[]>> = {
  comparison_scope_proof: ['evidence'],
  enterprise: ['qualityFlags'],
  enterprise_fact_revision: ['fact', 'actor'],
  file_declaration_669: ['part', 'pageRanges'],
  official_evidence_row_revision: ['actor'],
  platform_export_row: ['rawFields'],
  platform_observation_assignment: ['actor'],
  record: ['qualityFlags'],
  record_correspondence: ['targetIdentity', 'provenance'],
  record_event: ['formalValidity'],
}

export function postgresRosterRow(table: Table, alias: string) {
  const name = getTableName(table)
  const columns = getTableColumns(table)
  const officialEvidence = name === 'official_evidence_row_revision'
  const keys = orderedKeys[name] ?? Object.keys(columns).filter(key => !officialEvidence || !['nameRawJson', 'usccRawJson', 'districtRawJson'].includes(key))
  const casts = jsonFields[name] ?? []
  const fields = keys.map(key => {
    if (officialEvidence && Object.hasOwn(officialRawFieldColumns, key)) {
      return sql`${postgresOfficialRawField(alias, key as keyof typeof officialRawFieldColumns)} AS ${sql.identifier(key)}`
    }
    const column = columns[key]!
    const value = sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`
    const isJson = column.dataType === 'json' || casts.includes(key)
    return sql`${isJson ? sql`${value}::json` : value} AS ${sql.identifier(key)}`
  })
  return sql`(SELECT row_to_json(projected) FROM (SELECT ${sql.join(fields, sql`,`)}) projected)`
}
