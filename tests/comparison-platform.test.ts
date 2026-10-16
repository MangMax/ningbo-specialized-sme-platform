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
    { queryId, sequenceNo: 1, relationKey: 'SQ332022062212391', enterpriseId: withEvidence, usccRaw: USCC, nameRaw: '宁波上航测绘有限公司', aliasNameRaw: '宁波上航测绘有限公司', province: '宁波市', status: '终审通过', batch: '2022-1', declareKind: 'apply', appliedAt: '2022-06-22 17:17:52', year: 2022, matchBasis: 'uscc', verificationStatus: 'confirmed' },
    { queryId, sequenceNo: 2, relationKey: 'SQ332024052128274', enterpriseId: withEvidence, usccRaw: USCC, nameRaw: '宁波上航测绘股份有限公司', province: '宁波市', status: '终审通过', batch: '2024-1', declareKind: 'update', appliedAt: '2024-05-21', year: 2024, matchBasis: 'uscc', verificationStatus: 'confirmed' },
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

  it('没有解释记录的行仍带出**状态机默认态**「未查询」,而不是「无数据」(RL-15)', () => {
    const row = rows.find((r) => r.enterpriseId === withoutEvidence)!
    // 展示态只从 `difference_reason` 取;没有解释记录 ⇒ 状态机的 `not_queried`,
    // 由 `explanationId === null` 说清「还没存下解释」——**不**从查询/关系二次推导。
    expect(row.platform).not.toBeNull()
    expect(row.platform!.disposition).toMatchObject({
      explanationId: null,
      status: 'not_queried',
      reasonCode: null,
      measureCode: null,
    })
    // 那家企业确实没有轮询证据,但比对行本身不受影响。
    expect(row.platform!.queries).toEqual([])
    expect(row.platform!.relationCount).toBe(0)
    expect(row.name).toBe('宁波无证据企业')
    expect(row.direction).toBe('missing_in_miit')
  })

  it('解释记录带上它自己的行 id(用于区分「存过」与「还没存」)', () => {
    const row = rows.find((r) => r.enterpriseId === withEvidence)!
    expect(row.platform!.disposition!.explanationId).toBeGreaterThan(0)
  })

  it('查询带出**原始关系原文**(可展开的接口证据:时点、接口、关系)', () => {
    const row = rows.find((r) => r.enterpriseId === withEvidence)!
    const query = row.platform!.queries[0]!
    expect(query).toMatchObject({
      interface: 'business_list',
      queryKey: USCC,
      queriedAt: '2026-10-15T17:11:21.514Z',
      status: 'success',
      relationCount: 2,
    })
    expect(query.relations.map((r) => `${r.sequenceNo}:${r.relationKey}:${r.nameRaw}`)).toEqual([
      '1:SQ332022062212391:宁波上航测绘有限公司',
      '2:SQ332024052128274:宁波上航测绘股份有限公司',
    ])
    expect(query.relations[0]!.usccRaw).toBe(USCC)
    expect(query.relations[0]!.matchBasis).toBe('uscc')
    expect(query.relations[0]!.verificationStatus).toBe('confirmed')
  })

  it('只挂「对得上(企业, 称号, 方向)」的处置', () => {
    // 同一企业、同称号、但方向不同 ⇒ 不应借用 extra_in_miit 的那条。
    const mismatched = attachPlatformEvidence(
      [{ enterpriseId: withEvidence, titleCode: 'specialized_sme', direction: 'missing_in_miit' as const }],
      db,
    )
    // 没有对应的解释记录 ⇒ 状态机默认态,而不是借用另一个方向的结论。
    expect(mismatched[0]!.platform!.disposition).toMatchObject({
      explanationId: null,
      status: 'not_queried',
    })
    // 但别名与查询仍在(它们不按方向分)。
    expect(mismatched[0]!.platform!.aliases.length).toBe(2)
    expect(mismatched[0]!.platform!.queries).toHaveLength(1)
  })

  it('空输入不炸', () => {
    expect(attachPlatformEvidence([], db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 三称号的真实口径:状态/原因/措施**照库原样带出**,读侧不二次推导
// ---------------------------------------------------------------------------

describe('attachPlatformEvidence:状态、原因、措施照库原样带出', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'spztx-comparison-platform-titles-'))
  const db2 = useDb({ dbPath: join(dir2, 'titles.db') })

  function make(name: string, uscc: string | null, title: 'little_giant' | 'specialized_sme' | 'innovative_sme', source: 'jxj' | 'miit') {
    const id = db2.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning({ id: schema.enterprise.id }).get().id
    db2.insert(schema.record).values({ enterpriseId: id, source, titleCode: title }).run()
    return id
  }

  // 甲:无统代 ⇒ 平台查不了 ⇒ 库里落 `not_queried` + 转人工。页面必须如实显示**待核**,不装成有原因。
  const noUscc = make('宁波无统代企业', null, 'innovative_sme', 'jxj')
  db2.insert(schema.differenceReason).values({
    enterpriseId: noUscc,
    titleCode: 'innovative_sme',
    direction: 'missing_in_miit',
    status: 'not_queried',
    reasonCode: null,
    reasonNote: '本企业无统一社会信用代码;平台两接口只认 tyshxydm,无法直查。',
    measureCode: 'manual_review',
    measureNote: '先补统一社会信用代码。',
    verificationStatus: 'pending',
    recordedAt: '2026-10-16T03:33:27.157Z',
  }).run()

  // 乙:接口有记录、导出表滞后 ⇒ `platform_stale`。读侧**绝不能**把它显示成「无记录」。
  const stale = make('宁波平台滞后企业', '91330211000000002Y', 'specialized_sme', 'jxj')
  db2.insert(schema.differenceReason).values({
    enterpriseId: stale,
    titleCode: 'specialized_sme',
    direction: 'missing_in_miit',
    status: 'confirmed_reason',
    reasonCode: 'platform_stale',
    reasonNote: '平台关系状态「待审核」(2025-1),导出表尚未收录。',
    measureCode: 'mark_platform_snapshot',
    measureNote: '标明平台时点,不覆盖历史。',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-16T03:33:27.157Z',
  }).run()

  // 丙:还没有解释记录(还没轮询到的行)⇒ 状态机默认态「未查询」,不是「无数据」。
  const notYet = make('宁波尚未解释企业', '91330211000000003Z', 'little_giant', 'miit')

  const titleRows = attachPlatformEvidence(
    ['little_giant', 'specialized_sme', 'innovative_sme'].flatMap((title) =>
      getComparison(db2, { title: [title] as never }).rows,
    ),
    db2,
  )
  afterAll(() => rmSync(dir2, { recursive: true, force: true }))

  it('无统代条目:仓库里就是「未查询 + 转人工核实」,读侧不伪造原因', () => {
    const row = titleRows.find((r) => r.enterpriseId === noUscc)!
    expect(row.platform!.disposition).toMatchObject({
      status: 'not_queried',
      reasonCode: null,
      measureCode: 'manual_review',
      verificationStatus: 'pending',
    })
    expect(row.platform!.disposition!.reasonNote).toContain('无统一社会信用代码')
  })

  it('platform_stale 原样带出,读侧不把它改写成「无记录」/「已确认无差异」', () => {
    const row = titleRows.find((r) => r.enterpriseId === stale)!
    expect(row.platform!.disposition).toMatchObject({
      status: 'confirmed_reason',
      reasonCode: 'platform_stale',
      measureCode: 'mark_platform_snapshot',
    })
    expect(row.platform!.disposition!.status).not.toBe('no_record')
    expect(row.platform!.disposition!.status).not.toBe('confirmed_no_diff')
  })

  it('三称号的行都带得出 platform(不再有「无数据」的行)', () => {
    expect(titleRows.length).toBe(3)
    expect(titleRows.every((row) => row.platform !== null)).toBe(true)
    expect(new Set(titleRows.map((r) => r.titleCode)).size).toBe(3)
    const pending = titleRows.find((r) => r.enterpriseId === notYet)!
    expect(pending.platform!.disposition).toMatchObject({ explanationId: null, status: 'not_queried' })
  })
})
