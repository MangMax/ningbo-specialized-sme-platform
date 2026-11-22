import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './postgres-tables'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import type { CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-titles'
import type { PlatformRow } from '../../../layers/sme-roster/lib/platform/types'

type QualificationEvent = { eventType: 'award' | 'review'; year: number | null; batchSeq?: number | null; decidedYear?: number | null; reviewOutcome?: 'passed' | 'failed' | null }

export function qualificationMatrix(db: NodePgDatabase) {
  let sourceSequence = 0
  async function formal(name: string, events: QualificationEvent[], options: { uscc: string }) {
    const [enterprise] = await db.insert(schema.enterprise).values({
      name, nameNorm: name, usccNorm: options.uscc, city: '宁波市', district: '鄞州区',
    }).returning()
    if (!enterprise) throw new Error('Failed to seed qualification enterprise')
    const record = (await db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'innovative_sme', nameRaw: enterprise.name, usccRaw: enterprise.usccNorm }).returning())[0]!
    const saved = []
    for (const [index, event] of events.entries()) {
      const row = (await db.insert(schema.recordEvent).values({ recordId: record.id, ...event }).returning())[0]!
      await db.insert(schema.recordEvidence).values({ recordEventId: row.id, sourceFile: 'synthetic/408/matrix.pdf', listNo: index + 1 })
      saved.push(row)
    }
    return { enterprise, record, events: saved }
  }
  async function platform(enterpriseId: number, status: 'no_record' | 'failed' | 'not_queried' | 'success', rowStatus?: string) {
    const enterprise = (await db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)))[0]!
    const relations = rowStatus == null ? [] : [{ sequenceNo:1,enterpriseId,nameRaw:enterprise.name,usccRaw:enterprise.usccNorm,status:rowStatus,verificationStatus:'confirmed' as const,matchBasis:'manual' as const }]
    const result = await seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:enterprise.usccNorm ?? `name:${enterprise.nameNorm}`,titleCode:'innovative_sme',rdjb:'1',queriedAt:'2026-05-01T00:00:00Z',status,rawResponse:JSON.stringify({rows:relations}),relations})
    return { id: result.queryId }
  }
  async function recognized(enterpriseId: number, eventId: number, rawFields: PlatformRow) {
    const enterprise = (await db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)))[0]!
    const event = (await db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, eventId)))[0]!
    const record = (await db.select().from(schema.record).where(eq(schema.record.id, event.recordId)))[0]!
    const titleCode = record.titleCode as CurrentTitle
    const rdjb = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }[titleCode]
    const ordinal = sourceSequence++
    const stamp = `2026-05-01T00:00:${String(ordinal).padStart(2, '0')}Z`
    rawFields = { id: `synthetic408-recognized-${ordinal}`, qymc:enterprise.name,tyshxydm:enterprise.usccNorm!,rdjb,...rawFields }
    const evidence = {
      source: 'queryBusList' as const, status: 'success' as const, effectiveConditions: { uscc:enterprise.usccNorm!,combination: 'and' as const }, titleScope: { mode: 'selected' as const, rdjb: [rdjb] }, queriedAt: stamp, completedAt: stamp, rows: [rawFields], pages: [{ source: 'queryBusList' as const, rdjb, page: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    }
    const row = {sequenceNo:1,relationKey:rawFields.id,nameRaw:enterprise.name,usccRaw:enterprise.usccNorm,rawFields,enterpriseId,verificationStatus:'confirmed' as const,matchBasis:'uscc' as const}
    const result = await seedPostgresPlatformQuery(db,{interface:'recognized_list',queryKey:enterprise.usccNorm!,titleCode,rdjb,queriedAt:stamp,status:'success',collectionEvidence:evidence,relations:[row]})
    const relation = {...row,id:result.relationIds[0]!,queryId:result.queryId}
    return relation
  }
  return { formal, platform, recognized }
}
