import { enterprise as enterpriseTable } from '../../../../db/postgresql/enterprise-tables'
import * as ledger from '../../../../db/postgresql/ledger-tables'
import type { PostgresJobDb } from '../../../../layers/core/server/utils/job-runner-postgres'
import { singlePostgresFixtureRow } from '../../../support/isolated-postgres-cases'
import { seedPostgresPlatformQuery } from '../../../platform/fixtures/postgres-query'
import type { CorrespondenceRequest } from '../../../../layers/sme-roster/server/utils/record-correspondence-model'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'

export async function nativeCorrespondenceFixture(db: PostgresJobDb) {
  const enterprise = singlePostgresFixtureRow(await db.insert(enterpriseTable).values({ name: '合成平台企业', nameNorm: '合成平台企业', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(ledger.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning())
  const event = singlePostgresFixtureRow(await db.insert(ledger.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  let sequence = 0
  const add = async (options: { key?: string; status?: string; year?: number; titleCode?: string; rdjb?: string; enterpriseId?: number; verificationStatus?: 'pending' | 'confirmed'; matchBasis?: 'none' | 'uscc'; rawPadding?: string; queryRaw?: string } = {}) => {
    const n = ++sequence, key = options.key ?? 'BUSINESS-1'
    const seeded = await seedPostgresPlatformQuery(db, {
      interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: options.rdjb ?? '2', titleCode: options.titleCode ?? 'specialized_sme',
      queriedAt: `2026-10-20T00:${String(n).padStart(2, '0')}:00Z`, status: 'success', rawResponse: options.queryRaw ?? 'Synthetic original response',
      relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: options.enterpriseId ?? enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm,
        verificationStatus: options.verificationStatus ?? 'confirmed', matchBasis: options.matchBasis ?? 'uscc', rawFields: { id: key, year: options.year ?? 2024, sblx: '申请', sqsj: '2024-06-01', cszt: options.status ?? '终审通过', cookie: 'PRIVATE-COOKIE', ...(options.rawPadding ? { padding: options.rawPadding } : {}) } }],
    })
    return { id: seeded.relationIds[0]!, queryId: seeded.queryId }
  }
  const request = (key: string, operations: CorrespondenceRequest['operations']): CorrespondenceRequest => ({ idempotencyKey: key, sourceIdentity: `synthetic/${key}`, actor: { type: 'user', id: 'reviewer' }, basis: 'Explicit native source review', ruleId: 'manual', ruleVersion: '1', operations })
  const save = async (input: CorrespondenceRequest) => await commitPostgresCorrespondences(db, input, (await preflightPostgresCorrespondences(db, input)).planHash)
  const edge = (relationId: number) => ({ type: 'event_process' as const, eventId: event.id, relationId, role: 'context_only' as const })
  return { db, enterprise, record, event, add, request, save, edge }
}
