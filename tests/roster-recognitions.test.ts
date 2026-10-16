import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { listRosterEnterprises } from '../lib/roster/enterprise-roster'
import { listRosterRecognitions } from '../lib/roster/recognitions'

/**
 * RL-08 —— **首次认定的读模型**(契约 §7.5;§7.1 的 `firstRecognition` 是同一处计算)。
 *
 * 这一层测的是用户能观察到的东西:一行 = 一个**企业 × 称号**、它的首次年份、
 * 以及**为什么这个年份算数**(出处指到哪个文件 / 附件 / 序号;或者为什么标待确认)。
 *
 * 与 `tests/first-recognition.test.ts` 的分工:那边判纯函数口径,这边判**落库之后**
 * 的组织方式(企业 × 称号展开、计数单位、筛选判据、与总表共用同一处计算)。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-recognitions-'))
const db = useDb({ dbPath: join(dir, 'recognitions.db') })

const ids: Record<string, number> = {}

function enterprise(key: string, name: string, uscc: string | null, district: string | null = null) {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  ids[key] = id
  return id
}

interface EventSpec {
  eventType: 'award' | 'review' | 'maintain' | 'nurture'
  year?: number | null
  batchSeq?: number | null
  decidedYear?: number | null
  reviewOutcome?: 'passed' | 'failed' | null
  /** 出处:不给就是「这条事件没有存下来的出处」。 */
  evidence?: {
    sourceFile: string
    attachment?: string | null
    listNo?: number | null
    page?: number | null
  }[]
}

function record(
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
  events: EventSpec[],
) {
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source })
    .returning({ id: schema.record.id })
    .get().id
  for (const e of events) {
    const eventId = db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year ?? null,
        batchSeq: e.batchSeq ?? null,
        decidedYear: e.decidedYear === undefined ? (e.year ?? null) : e.decidedYear,
        reviewOutcome: e.reviewOutcome ?? null,
      })
      .returning({ id: schema.recordEvent.id })
      .get().id
    for (const v of e.evidence ?? []) {
      db.insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          sourceFile: v.sourceFile,
          attachment: v.attachment ?? null,
          listNo: v.listNo ?? null,
          page: v.page ?? null,
        })
        .run()
    }
  }
  return recordId
}

const FILE_2022 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
const FILE_2025 = 'jxj/announcement/2025/1/(此份为准)关于公布2025年第一批认定宁波市专精特新中小企业名单的通知.pdf'

beforeAll(() => {
  // 甲:专精特新 **2021 认定 → 2024 复核未通过 → 2025 再次获批**;另加一个创新型 2022 认定。
  //    ⇒ 两行(企业 × 称号),专精特新那行的首次仍是 **2021**。
  const jia = enterprise('jia', '甲企业有限公司', '91330211AAAAAA0001X', '北仑区')
  record(jia, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: 2021, evidence: [{ sourceFile: FILE_2022, attachment: '附件一', listNo: 74 }] },
    { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' },
    { eventType: 'award', year: 2025, evidence: [{ sourceFile: FILE_2025, attachment: '附件一', listNo: 3 }] },
  ])
  record(jia, 'innovative_sme', 'jxj', [
    { eventType: 'award', year: 2022, evidence: [{ sourceFile: 'jxj/announcement/2022/公布.pdf', attachment: '附件二', listNo: 6 }] },
  ])

  // 乙:专精特新 2021 认定,但**这条事件没有存下来的出处** ⇒ 待确认(依据回不到出处)。
  const yi = enterprise('yi', '乙企业有限公司', '91330211AAAAAA0002X', '余姚市')
  record(yi, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2021 }])

  // 丙:专精特新有一条**定不了年**的 award(可能更早) + 一条 2024 认定 ⇒ 待确认,但年份照给。
  const bing = enterprise('bing', '丙企业有限公司', '91330211AAAAAA0003X', '象山县')
  record(bing, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: null, decidedYear: null },
    { eventType: 'award', year: 2024, evidence: [{ sourceFile: 'jxj/announcement/2024/公布.pdf', listNo: 9 }] },
  ])

  // 丁:一个称号都没有正式认定(只有入库培育与维护)⇒ 首次认定行里**不该有它**。
  const ding = enterprise('ding', '丁企业有限公司', '91330211AAAAAA0004X', '海曙区')
  record(ding, 'little_giant', 'miit', [{ eventType: 'nurture', year: 2023 }])
  record(ding, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025 }])

  // 戊:小巨人**跨批次**两次认定(第 2 批 2020、第 6 批 2024)⇒ 首次取最早那条。
  const wu = enterprise('wu', '戊企业有限公司', '91330211AAAAAA0005X', '高新区')
  record(wu, 'little_giant', 'jxj', [
    { eventType: 'award', year: 2020, batchSeq: 2, evidence: [{ sourceFile: 'jxj/workbook/小巨人历史名单.xlsx', listNo: 12 }] },
    { eventType: 'award', year: 2024, batchSeq: 6, evidence: [{ sourceFile: 'jxj/announcement/2024/第六批.pdf', listNo: 40 }] },
  ])
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** `rows` 按企业名 + 称号列成可读的键,断言不看顺序。 */
const keys = (rows: { name: string; titleCode: string }[]) =>
  rows.map((r) => `${r.name}/${r.titleCode}`).sort()

describe('§7.5 首次认定 —— 一行 = 一个企业 × 称号', () => {
  it('每个有 award 的(企业 × 称号)各一行;没有 award 的称号不出行', () => {
    const out = listRosterRecognitions(db, { pageSize: 200 })
    expect(keys(out.rows)).toEqual([
      '丙企业有限公司/specialized_sme',
      '乙企业有限公司/specialized_sme',
      '戊企业有限公司/little_giant',
      '甲企业有限公司/innovative_sme',
      '甲企业有限公司/specialized_sme',
    ])
    // 丁企业只有 nurture / maintain ⇒ 一条首次认定都没有。
    expect(out.rows.some((r) => r.name === '丁企业有限公司')).toBe(false)
  })

  it('跨批次两次认定:首次取**最早**那条,出处也跟着最早那条', () => {
    const row = listRosterRecognitions(db, { title: ['little_giant'], pageSize: 200 }).rows[0]!
    expect(row.firstYear).toBe(2020)
    expect(row.evidence[0]!.sourceFile).toBe('jxj/workbook/小巨人历史名单.xlsx')
    expect(row.evidence[0]!.listNo).toBe(12)
  })

  it('复核失败后再次获批:首次年份与出处都停在**最早那条**认定上', () => {
    const row = listRosterRecognitions(db, { pageSize: 200 }).rows.find(
      (r) => r.name === '甲企业有限公司' && r.titleCode === 'specialized_sme',
    )!
    expect(row.firstYear).toBe(2021)
    expect(row.status).toBe('confirmed')
    // 出处必须能回到 2022 年那份公布件(2021 年认定),**不是** 2025 那份。
    expect(row.evidence[0]!.sourceFile).toBe(FILE_2022)
    expect(row.evidence[0]!.attachment).toBe('附件一')
    expect(row.evidence[0]!.listNo).toBe(74)
  })

  it('同一企业的两个称号各出一行,各算各的首次年份', () => {
    const rows = listRosterRecognitions(db, { title: ['innovative_sme'], pageSize: 200 }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('甲企业有限公司')
    expect(rows[0]!.firstYear).toBe(2022)
  })

  it('计数单位写清:企业数 ≠ 企业 × 称号数', () => {
    const out = listRosterRecognitions(db, { pageSize: 200 })
    // 5 个企业 × 称号,来自 4 家企业(甲有两行)。
    expect(out.counts.titlePairs).toBe(5)
    expect(out.counts.enterprises).toBe(4)
    expect(out.page).toBe(1)
    expect(out.pageSize).toBe(200)
  })

  it('待确认原因如实带出:没有出处 / 有无法定年的更早候选', () => {
    const rows = listRosterRecognitions(db, { pageSize: 200 }).rows
    const yi = rows.find((r) => r.name === '乙企业有限公司')!
    expect(yi.status).toBe('pending')
    expect(yi.pendingReason).toBe('no_evidence')

    const bing = rows.find((r) => r.name === '丙企业有限公司')!
    expect(bing.firstYear).toBe(2024)
    expect(bing.status).toBe('pending')
    expect(bing.pendingReason).toBe('undated_award')
  })
})

describe('§7.5 筛选判据', () => {
  it('title / year(首次认定年份)/ status 各筛各的,多值取或', () => {
    expect(keys(listRosterRecognitions(db, { title: ['specialized_sme'], pageSize: 200 }).rows)).toEqual([
      '丙企业有限公司/specialized_sme',
      '乙企业有限公司/specialized_sme',
      '甲企业有限公司/specialized_sme',
    ])
    expect(keys(listRosterRecognitions(db, { year: [2021], pageSize: 200 }).rows)).toEqual([
      '乙企业有限公司/specialized_sme',
      '甲企业有限公司/specialized_sme',
    ])
    expect(keys(listRosterRecognitions(db, { status: ['pending'], pageSize: 200 }).rows)).toEqual([
      '丙企业有限公司/specialized_sme',
      '乙企业有限公司/specialized_sme',
    ])
    // 多值取或。
    expect(keys(listRosterRecognitions(db, { year: [2021, 2022], pageSize: 200 }).rows)).toEqual([
      '乙企业有限公司/specialized_sme',
      '甲企业有限公司/innovative_sme',
      '甲企业有限公司/specialized_sme',
    ])
  })

  it('判据之间取与;筛不中就是空集(不是退化成不筛)', () => {
    expect(
      keys(listRosterRecognitions(db, { title: ['specialized_sme'], status: ['pending'], pageSize: 200 }).rows),
    ).toEqual(['丙企业有限公司/specialized_sme', '乙企业有限公司/specialized_sme'])
    const none = listRosterRecognitions(db, { year: [1999], pageSize: 200 })
    expect(none.rows).toEqual([])
    expect(none.counts.titlePairs).toBe(0)
    expect(none.counts.enterprises).toBe(0)
  })

  it('计数与筛选同口径、先于分页', () => {
    const out = listRosterRecognitions(db, { title: ['specialized_sme'], pageSize: 1 })
    expect(out.rows).toHaveLength(1)
    expect(out.counts.titlePairs).toBe(3)
    expect(out.counts.enterprises).toBe(3)
    expect(out.pageSize).toBe(1)
  })

  it('分页取第二页不重复不遗漏', () => {
    const p1 = listRosterRecognitions(db, { pageSize: 3, page: 1 }).rows
    const p2 = listRosterRecognitions(db, { pageSize: 3, page: 2 }).rows
    expect(p1).toHaveLength(3)
    expect(p2).toHaveLength(2)
    const all = listRosterRecognitions(db, { pageSize: 200 }).rows
    expect([...p1, ...p2].map((r) => r.firstEventId)).toEqual(all.map((r) => r.firstEventId))
  })
})

describe('§7.1 总表的首次认定筛选取自**同一处计算**', () => {
  it('有首次认定的称号数 = 总表的 recognitionPairs 计数', () => {
    const out = listRosterEnterprises(db, { pageSize: 200 })
    const rows = listRosterRecognitions(db, { pageSize: 200 })
    expect(out.counts.recognitionPairs).toBe(rows.counts.titlePairs)
    // 逐条对齐:总表每行展开出来的 firstRecognition 与 §7.5 的行一一对应。
    const fromRoster = out.rows
      .flatMap((r) => r.firstRecognition.map((f) => `${r.name}/${f.titleCode}/${f.year}`))
      .sort()
    const fromRecognitions = rows.rows
      .map((r) => `${r.name}/${r.titleCode}/${r.firstYear}`)
      .sort()
    expect(fromRoster).toEqual(fromRecognitions)
  })

  it('firstYear 判据命中有该年份首次认定的企业', () => {
    const rows = listRosterEnterprises(db, { firstYear: [2021], pageSize: 200 }).rows
    expect(rows.map((r) => r.name).sort()).toEqual(['乙企业有限公司', '甲企业有限公司'])
  })

  it('recognitionPairs 数的是**符合本次筛选**的首次认定,不是「符合条件企业的全部称号」', () => {
    // 限定创新型:命中 1 家(甲),它的首次认定里只有创新型那一条符合 ⇒ 1。
    // 若按「符合条件企业的全部首次认定」算,这里会给出 2(把甲企业的专精特新也数进去)——
    // 那正是「筛出来 1 条、计数说 2 条」的来源。
    const only = listRosterEnterprises(db, { title: ['innovative_sme'], pageSize: 200 })
    expect(only.rows.map((r) => r.name)).toEqual(['甲企业有限公司'])
    expect(only.counts.recognitionPairs).toBe(1)
    // 不带称号判据只按首次认定年份筛:甲(专精特新 2021)+ 乙 ⇒ 2。
    expect(listRosterEnterprises(db, { firstYear: [2021], pageSize: 200 }).counts.recognitionPairs).toBe(2)
  })

  it('firstStatus 判据命中首次认定待确认的企业', () => {
    const rows = listRosterEnterprises(db, { firstStatus: ['pending'], pageSize: 200 }).rows
    expect(rows.map((r) => r.name).sort()).toEqual(['丙企业有限公司', '乙企业有限公司'])
    const confirmed = listRosterEnterprises(db, { firstStatus: ['confirmed'], pageSize: 200 }).rows
    expect(confirmed.map((r) => r.name).sort()).toEqual(['甲企业有限公司', '戊企业有限公司'].sort())
  })

  it('★ title 与 firstYear 必须落在**同一个称号**上(否则同一个 URL 会有两种意思)', () => {
    // 甲企业的创新型是 2022、专精特新是 2021。
    // 给「创新型 + 2021」不该命中它 —— 那是把两个称号的判据各取一个拼起来的。
    expect(
      listRosterEnterprises(db, { title: ['innovative_sme'], firstYear: [2021], pageSize: 200 }).rows,
    ).toEqual([])
    expect(
      listRosterEnterprises(db, { title: ['innovative_sme'], firstYear: [2022], pageSize: 200 }).rows.map((r) => r.name),
    ).toEqual(['甲企业有限公司'])
    expect(
      listRosterEnterprises(db, { title: ['specialized_sme'], firstYear: [2021], pageSize: 200 }).rows.map((r) => r.name).sort(),
    ).toEqual(['乙企业有限公司', '甲企业有限公司'])
  })

  it('firstYear 与 firstStatus 也落在同一个称号上', () => {
    // 甲:专精特新 2021(已确立)、创新型 2022(已确立)⇒ 「创新型 + 待确认」不命中。
    expect(
      listRosterEnterprises(db, { title: ['innovative_sme'], firstStatus: ['pending'], pageSize: 200 }).rows,
    ).toEqual([])
  })

  it('判据没给时与 RL-04 完全一致(不动既有筛选的含义)', () => {
    const base = listRosterEnterprises(db, { pageSize: 200 })
    const withUndefined = listRosterEnterprises(db, { firstYear: undefined, firstStatus: undefined, pageSize: 200 })
    expect(withUndefined.rows).toEqual(base.rows)
    expect(withUndefined.counts).toEqual(base.counts)
  })
})
