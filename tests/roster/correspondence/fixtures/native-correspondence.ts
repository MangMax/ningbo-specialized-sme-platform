import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb, schema } from '../../../../db/client'
import { submitNativePlatformQuery } from '../../../platform/fixtures/native-query'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from '../../../../layers/sme-roster/server/utils/record-correspondence'

export function nativeCorrespondenceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-correspondence-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'isolated.db') })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成平台企业', nameNorm: '合成平台企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  let sequence = 0
  const add = (options: { key?: string; status?: string; year?: number; titleCode?: string; rdjb?: string; enterpriseId?: number; rawPadding?: string; queryRaw?: string } = {}) => {
    const n = ++sequence, key = options.key ?? 'BUSINESS-1'
    const seeded = submitNativePlatformQuery(db, {
      interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: options.rdjb ?? '2', titleCode: options.titleCode ?? 'specialized_sme',
      queriedAt: `2026-10-20T00:${String(n).padStart(2, '0')}:00Z`, status: 'success', rawResponse: options.queryRaw ?? 'Synthetic original response',
      relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: options.enterpriseId ?? enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm,
        verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: key, year: options.year ?? 2024, sblx: '申请', sqsj: '2024-06-01', cszt: options.status ?? '终审通过', cookie: 'PRIVATE-COOKIE', ...(options.rawPadding ? { padding: options.rawPadding } : {}) } }],
    })
    return { id: seeded.relationIds[0]!, queryId: seeded.queryId, observationId: seeded.observations[0]!.observationId }
  }
  const request = (key: string, operations: CorrespondenceRequest['operations']): CorrespondenceRequest => ({ idempotencyKey: key, sourceIdentity: `synthetic/${key}`, actor: { type: 'user', id: 'reviewer' }, basis: 'Explicit native source review', ruleId: 'manual', ruleVersion: '1', operations })
  const save = (input: CorrespondenceRequest) => commitRecordCorrespondences(db, input, preflightRecordCorrespondences(db, input).planHash)
  const edge = (relationId: number) => ({ type: 'event_process' as const, eventId: event.id, relationId, role: 'context_only' as const })
  return { db, dir, enterprise, record, event, add, request, save, edge, close: () => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) } }
}
