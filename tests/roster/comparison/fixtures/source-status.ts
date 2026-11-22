import { seedPostgresPlatformQuery } from '../../../platform/fixtures/postgres-query'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { singlePostgresFixtureRow } from '../../../support/isolated-postgres-cases'
import * as schema from '../../fixtures/postgres-tables'
import { platformExportBatch, platformExportRow } from '../../../../db/postgresql/platform-tables'
import type { PlatformInterface } from '../../../../layers/sme-roster/lib/labels'

/** Explicit native synthetic original commands; never use a live database. */
export async function seedComparisonSourceStatus(db: NodePgDatabase) {
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'issue301状态事实企业', nameNorm: 'issue301状态事实企业', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme', usccRaw: enterprise.usccNorm }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).returning())
  const rawResponse = '  {"原始响应":"🙂\\n保留空白与字节"}\n'
  const cases = []
  const inputs = [
    { label: 'apply-raw', source: 'apply_list', stored: null, raw: '终审通过', expected: '终审通过' },
    { label: 'business-raw', source: 'business_list', stored: null, raw: '终审通过', expected: '终审通过' },
    { label: 'unknown', source: 'apply_list', stored: null, raw: '上游新状态-X9', expected: '上游新状态-X9' },
    { label: 'missing', source: 'business_list', stored: null, raw: null, expected: null },
    { label: 'recognized-is-not-process', source: 'recognized_list', stored: null, raw: '终审通过', expected: null },
  ] satisfies Array<{ label: string; source: PlatformInterface; stored: string | null; raw: string | null; expected: string | null }>
  for (const [index, item] of inputs.entries()) {
    const queriedAt = `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`
    const rawFields = { id: `issue301-${item.label}`, tyshxydm: enterprise.usccNorm!, qymc: item.label, cszt: item.raw, sblx: '申请', sqsj: '2025-01-02', year: '2025', whpc: '2025-2', nested: { value: [false, 0, null, '🙂'] } }
    const row = { sequenceNo: 1, relationKey: rawFields.id, enterpriseId: enterprise.id, nameRaw: item.label, usccRaw: enterprise.usccNorm, rawFields, sourceText: `原行🙂 ${item.label}\n`, matchBasis: 'uscc' as const, verificationStatus: 'confirmed' as const }
    const native = await seedPostgresPlatformQuery(db, { interface: item.source, queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success', rawResponse,
      ...(item.source === 'recognized_list' ? { collectionEvidence: { source: 'queryBusList' as const, status: 'success' as const, effectiveConditions: { uscc: enterprise.usccNorm!, combination: 'and' as const }, titleScope: { mode: 'selected' as const, rdjb: ['2'] }, queriedAt, completedAt: queriedAt, rows: [{ ...rawFields, cszt: item.raw ?? '', nested: JSON.stringify(rawFields.nested) }], dataRows: [rawFields], pages: [{ source: 'queryBusList' as const, rdjb: '2', page: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null, limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 } } } : {}), relations: [row] })
    const query = { id: native.queryId, interface: item.source }
    const relation = { id: native.relationIds[0]! }
    cases.push({ ...item, query, relation })
  }
  const decision = singlePostgresFixtureRow(await db.insert(schema.differenceReason).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: '2026-10-20T00:00:00Z', evidenceQueryId: cases[0]!.query.id, evidenceRelationId: cases[0]!.relation.id, createdAt: '2026-10-20T00:00:00Z' }).returning())
  const batch = singlePostgresFixtureRow(await db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2025, collectedOn: '2026-10-01', originalFilename: 'issue301-synthetic.xlsx', sha256: '3'.repeat(64), rowCount: 1, importStatus: 'imported', createdAt: '2026-10-01T00:00:00Z' }).returning())
  const exportRow = singlePostgresFixtureRow(await db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 2, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, regStatus: '终审通过', rawFields: JSON.stringify({ 审核状态: '终审通过' }), createdAt: '2026-10-01T00:00:00Z' }).returning())
  await db.insert(schema.recordCorrespondence).values({ edgeKey: 'issue301-export', type: 'event_export_context', role: 'current_snapshot_context', eventId: event.id, exportRowId: exportRow.id, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: '{}', provenance: '{}', sourceFingerprint: '3'.repeat(64), ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-20T00:00:00Z' })
  return { enterprise, cases, rawResponse, decision: { ...decision, evidenceQueryId: cases[0]!.query.id, evidenceRelationId: cases[0]!.relation.id }, exportRow }
}
