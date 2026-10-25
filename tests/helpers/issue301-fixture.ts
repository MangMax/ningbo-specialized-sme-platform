import type { useDb } from '../../db'
import { schema } from '../../db'

/** Historical rows deliberately predate normalization; never use a live database. */
export function seedIssue301(db: ReturnType<typeof useDb>) {
  const enterprise = db.insert(schema.enterprise).values({ name: 'issue301状态事实企业', nameNorm: 'issue301状态事实企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).returning().get()
  const rawResponse = '  {"原始响应":"🙂\\n保留空白与字节"}\n'
  const cases = [
    { label: 'apply-raw', source: 'apply_list', stored: null, raw: '终审通过', expected: '终审通过' },
    { label: 'business-raw', source: 'business_list', stored: null, raw: '终审通过', expected: '终审通过' },
    { label: 'status-conflict', source: 'business_list', stored: '已退回', raw: '终审通过', expected: null },
    { label: 'unknown', source: 'apply_list', stored: null, raw: '上游新状态-X9', expected: '上游新状态-X9' },
    { label: 'missing', source: 'business_list', stored: null, raw: null, expected: null },
    { label: 'recognized-is-not-process', source: 'recognized_list', stored: null, raw: '终审通过', expected: null },
  ].map((item, index) => {
    const query = db.insert(schema.platformQuery).values({ interface: item.source, queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`, status: 'success', rawResponse }).returning().get()
    const rawFields = { qymc: item.label, cszt: item.raw, sblx: '申请', sqsj: '2025-01-02', year: '2025', whpc: '2025-2', nested: { value: [false, 0, null, '🙂'] } }
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: `issue301-${item.label}`, enterpriseId: enterprise.id, nameRaw: item.label, usccRaw: enterprise.usccNorm, status: item.stored, rawFields, sourceText: `原行🙂 ${item.label}\n`, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    return { ...item, query, relation }
  })
  const decision = db.insert(schema.differenceReason).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: '2026-10-20T00:00:00Z', evidenceQueryId: cases[0]!.query.id, evidenceRelationId: cases[0]!.relation.id }).returning().get()
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2025, collectedOn: '2026-10-01', originalFilename: 'issue301-synthetic.xlsx', sha256: '3'.repeat(64), rowCount: 1, importStatus: 'imported' }).returning().get()
  const exportRow = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 2, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, regStatus: '终审通过', rawFields: { 审核状态: '终审通过' } }).returning().get()
  db.insert(schema.recordCorrespondence).values({ edgeKey: 'issue301-export', type: 'event_export_context', role: 'current_snapshot_context', eventId: event.id, exportRowId: exportRow.id, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: '3'.repeat(64), ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-20T00:00:00Z' }).run()
  return { enterprise, cases, rawResponse, decision, exportRow }
}
