import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { getComparison } from '../lib/comparison'
import { attachPlatformEvidence } from '../lib/comparison-platform'

const dir = mkdtempSync(join(tmpdir(), 'spztx-comparison-platform-'))
const db = useDb({ dbPath: join(dir, 'comparison-platform.db') })

const USCC = '91330211255994457P'

function enterprise(name: string, uscc: string | null) {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function record(enterpriseId: number, source: 'jxj' | 'miit', titleCode: 'specialized_sme' | 'innovative_sme' = 'specialized_sme') {
  return db
    .insert(schema.record)
    .values({ enterpriseId, source, titleCode, district: '镇海区' })
    .returning({ id: schema.record.id })
    .get().id
}

// 甲:只有 miit ⇒ extra_in_miit,带平台证据。
// 乙:只有 jxj ⇒ missing_in_miit,无平台证据(platform 应为 null)。
const withEvidence = enterprise('宁波上航测绘股份有限公司', USCC)
record(withEvidence, 'miit')
const withoutEvidence = enterprise('宁波无证据企业', '91330211000000001X')
record(withoutEvidence, 'jxj')

// 曾用名:一条 confirmed(可搜索)、一条 pending(待核)。
db.insert(schema.enterpriseAlias)
  .values([
    {
      enterpriseId: withEvidence,
      name: '宁波上航测绘有限公司',
      nameNorm: '宁波上航测绘有限公司',
      sourceKind: 'platform_business',
      sourceRefId: 0,
      verificationStatus: 'confirmed',
      validFrom: '2022-06-22 17:17:52',
      note: '平台关系 SQ332022062212391 明确写出',
    },
    {
      enterpriseId: withEvidence,
      name: '宁波疑似旧名有限公司',
      nameNorm: '宁波疑似旧名有限公司',
      sourceKind: 'platform_apply',
      sourceRefId: 0,
      verificationStatus: 'pending',
    },
  ])
  .run()

const queryId = db
  .insert(schema.platformQuery)
  .values({ interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: '2026-10-15T17:11:21.514Z', status: 'success' })
  .returning({ id: schema.platformQuery.id })
  .get().id
db.insert(schema.platformRelation)
  .values([
    { queryId, sequenceNo: 1, relationKey: 'SQ332022062212391', enterpriseId: withEvidence, usccRaw: USCC, nameRaw: '宁波上航测绘有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
    { queryId, sequenceNo: 2, relationKey: 'SQ332024052128274', enterpriseId: withEvidence, usccRaw: USCC, nameRaw: '宁波上航测绘股份有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
  ])
  .run()

// 时态化:同一差异两条解释,展示取 recordedAt 最新那条。
db.insert(schema.differenceReason)
  .values([
    {
      enterpriseId: withEvidence,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'needs_review',
      reasonCode: 'other',
      recordedAt: '2026-10-01T00:00:00.000Z',
      evidenceQueryId: queryId,
    },
    {
      enterpriseId: withEvidence,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'renamed',
      measureCode: 'update_current_name',
      measureNote: '旧名保留为曾用名',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-14T00:00:00.000Z',
      evidenceQueryId: queryId,
    },
  ])
  .run()

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rows = attachPlatformEvidence(
  getComparison(db, { title: ['specialized_sme'] }).rows,
  db,
)

describe('attachPlatformEvidence:库内证据挂在比对行上', () => {
  it('现名/曾用名可查:confirmed 与 pending 都带出,带核验状态', () => {
    const row = rows.find((r) => r.enterpriseId === withEvidence)!
    const names = row.platform!.aliases.map((a) => `${a.name}:${a.verificationStatus}`)
    expect(names).toContain('宁波上航测绘有限公司:confirmed')
    expect(names).toContain('宁波疑似旧名有限公司:pending')
    expect(row.platform!.aliases[0]!.validFrom ?? row.platform!.aliases[1]!.validFrom).toBeTruthy()
  })

  it('已核验处置取 recordedAt 最新那条(时态化,旧解释不丢但只展示当前)', () => {
    const row = rows.find((r) => r.enterpriseId === withEvidence)!
    expect(row.platform!.disposition).toMatchObject({
      status: 'confirmed_reason',
      reasonCode: 'renamed',
      measureCode: 'update_current_name',
      recordedAt: '2026-10-14T00:00:00.000Z',
    })
  })

  it('平台查询与关系条数带出,供「查看全部关系」跳转', () => {
    const row = rows.find((r) => r.enterpriseId === withEvidence)!
    expect(row.platform!.relationCount).toBe(2)
    expect(row.platform!.queries).toHaveLength(1)
    expect(row.platform!.queries[0]).toMatchObject({ rdjb: '3', status: 'success', relationCount: 2 })
  })

  it('没有平台证据的行 platform 为 null,比对行本身不受影响', () => {
    const row = rows.find((r) => r.enterpriseId === withoutEvidence)!
    expect(row.platform).toBeNull()
    expect(row.name).toBe('宁波无证据企业')
    expect(row.direction).toBe('missing_in_miit')
  })

  it('只挂「对得上(企业, 称号, 方向)」的处置', () => {
    // 同一企业、同称号、但方向不同 ⇒ 不应借用 extra_in_miit 的那条。
    const mismatched = attachPlatformEvidence(
      [{ enterpriseId: withEvidence, titleCode: 'specialized_sme', direction: 'missing_in_miit' as const }],
      db,
    )
    expect(mismatched[0]!.platform!.disposition).toBeNull()
    // 但别名与查询仍在(它们不按方向分)。
    expect(mismatched[0]!.platform!.aliases.length).toBe(2)
  })

  it('空输入不炸', () => {
    expect(attachPlatformEvidence([], db)).toEqual([])
  })
})
