import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { EVENT_ORDER, SOURCE_ORDER } from '../lib/labels'
import { listRecords } from '../lib/query'
import {
  allRosterEnterprises,
  listRosterDifferences,
  listRosterEnterprises,
} from '../lib/roster/enterprise-roster'
import {
  parseRosterDifferenceQuery,
  parseRosterEnterpriseQuery,
} from '../server/utils/roster-read-query'

/**
 * RL-17 —— 合并台账所需的**来源 / 事件 / 年份**判据(对 RL-04 读模型的增量)。
 *
 * 为什么需要它们:合并后只剩一个入口 `/`,而 `/stats` 的下钻是
 * `/?title=…&source=…&eventType=…&year=…`(统计页 `drillTo`)。若企业粒度不认这三项,
 * 下钻会**静默变成不筛** —— 点「miit 8,123 条」看到的却是不筛的全部企业。
 *
 * 口径(与 `/api/records` 的企业×称号口径同构,只是抬到企业):
 *  - `source`   命中「该企业**存在**一条该来源的记录」;
 *  - `eventType` 命中「该企业**存在**一条该类型的事件」;
 *  - `year`     命中「该企业**存在**一条该年份的事件」。
 * 同一参数内多值取**或**,不同参数之间取**与**。
 *
 * `counts` 仍按**企业**计数(total = 符合条件的企业数),不因为判据落在记录上就变成记录数。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-ledger-filters-'))
const db = useDb({ dbPath: join(dir, 'ledger.db') })

interface EventSpec {
  eventType: 'award' | 'review' | 'maintain' | 'nurture'
  year?: number | null
}

const ids: Record<string, number> = {}

function enterprise(key: string, name: string, uscc: string, district: string | null = null) {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  ids[key] = id
  return id
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
    db.insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year ?? null,
        decidedYear: e.year ?? null,
      })
      .run()
  }
}

beforeAll(() => {
  // `createError` 是 Nitro 的运行时全局:裸 node 下不存在(`tests/setup.ts` 只垫了
  // 编译期宏 `defineRouteMeta`)。给一个与 nitro 同形状的实现,好让「非法值 ⇒ 400」
  // 这条在**同一份解析函数**上被判到,而不是另写一个替身。
  vi.stubGlobal('createError', (opts: { statusMessage?: string; statusCode?: number }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )

  // 甲:两个称号 × 两个来源,事件类型与年份都全。
  const jia = enterprise('jia', '甲企业有限公司', '91330211AAAAAA0001X', '北仑区')
  record(jia, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2026 }])
  record(jia, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2023 }])
  record(jia, 'specialized_sme', 'miit', [{ eventType: 'review', year: 2025 }])

  // 乙:只有经信局一条,事件是认定 2021。
  const yi = enterprise('yi', '乙企业有限公司', '91330211AAAAAA0002X', '余姚市')
  record(yi, 'innovative_sme', 'jxj', [{ eventType: 'award', year: 2021 }])

  // 丙:没有任何事件(只有一条空记录)—— 用来证明 `eventType` / `year` 判据
  //     不是「有记录就算」。
  const bing = enterprise('bing', '丙企业有限公司', '91330211AAAAAA0003X', '象山县')
  record(bing, 'innovative_sme', 'miit', [])

  // 丁:连记录都没有 —— 任何记录侧判据都不该命中它。
  enterprise('ding', '丁企业有限公司', '91330211AAAAAA0004X', '海曙区')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort()

describe('listRosterEnterprises —— source 判据', () => {
  it('命中「存在该来源的记录」的企业', () => {
    const miit = listRosterEnterprises(db, { source: ['miit'] })
    expect(names(miit.rows)).toEqual(['丙企业有限公司', '甲企业有限公司'])
    const jxj = listRosterEnterprises(db, { source: ['jxj'] })
    expect(names(jxj.rows)).toEqual(['乙企业有限公司', '甲企业有限公司'])
  })

  it('多值取或,并集不重复同一家企业', () => {
    const both = listRosterEnterprises(db, { source: ['jxj', 'miit'] })
    expect(names(both.rows)).toEqual(['丙企业有限公司', '乙企业有限公司', '甲企业有限公司'])
  })

  it('没给这个判据时与 RL-04 完全一致(连记录都没有的企业也在)', () => {
    // `names()` 用默认排序,所以这里按 UTF-16 码位写:丁(4E01) < 丙(4E19) < 乙(4E59) < 甲(7532)。
    expect(names(listRosterEnterprises(db, {}).rows)).toEqual([
      '丁企业有限公司',
      '丙企业有限公司',
      '乙企业有限公司',
      '甲企业有限公司',
    ])
  })
})

describe('listRosterEnterprises —— eventType 判据', () => {
  it('只命中真有一条该类型事件的企业,不是「有记录就算」', () => {
    expect(names(listRosterEnterprises(db, { eventType: ['review'] }).rows)).toEqual([
      '甲企业有限公司',
    ])
    expect(names(listRosterEnterprises(db, { eventType: ['maintain'] }).rows)).toEqual([
      '甲企业有限公司',
    ])
    expect(names(listRosterEnterprises(db, { eventType: ['award'] }).rows)).toEqual([
      '乙企业有限公司',
      '甲企业有限公司',
    ])
  })

  it('多值取或', () => {
    expect(names(listRosterEnterprises(db, { eventType: ['review', 'award'] }).rows)).toEqual([
      '乙企业有限公司',
      '甲企业有限公司',
    ])
  })
})

describe('listRosterEnterprises —— year 判据', () => {
  it('命中存在该年份事件的企业', () => {
    expect(names(listRosterEnterprises(db, { year: [2021] }).rows)).toEqual(['乙企业有限公司'])
    expect(names(listRosterEnterprises(db, { year: [2025] }).rows)).toEqual(['甲企业有限公司'])
  })

  it('该年份没有任何事件时命中空集(不是退化成不筛)', () => {
    const none = listRosterEnterprises(db, { year: [1999] })
    expect(none.rows).toEqual([])
    expect(none.counts.total).toBe(0)
  })
})

describe('listRosterEnterprises —— 判据之间取与,且落在同一条记录 / 同一条事件上', () => {
  it('来源与事件必须落在同一条记录上', () => {
    // 甲企业的 miit 记录各自带 maintain 2026 / review 2025,一条 2023 事件也没有;
    // 它的 2023 认定挂在**经信局**那条记录上。所以这两项一起给时不命中。
    expect(names(listRosterEnterprises(db, { source: ['miit'], year: [2023] }).rows)).toEqual([])
    expect(names(listRosterEnterprises(db, { source: ['miit'], eventType: ['award'] }).rows)).toEqual([])
    // 换成它那条记录上真有的事件,就命中。
    expect(names(listRosterEnterprises(db, { source: ['miit'], eventType: ['review'] }).rows)).toEqual([
      '甲企业有限公司',
    ])
  })

  it('类型与年份必须落在同一条事件上', () => {
    // 乙企业是认定 2021:单看类型命中,单看年份也命中,合起来给 2023 就不命中。
    expect(names(listRosterEnterprises(db, { eventType: ['award'] }).rows)).toEqual([
      '乙企业有限公司',
      '甲企业有限公司',
    ])
    expect(names(listRosterEnterprises(db, { eventType: ['award'], year: [2023] }).rows)).toEqual([
      '甲企业有限公司',
    ])
    expect(names(listRosterEnterprises(db, { eventType: ['award'], year: [2021] }).rows)).toEqual([
      '乙企业有限公司',
    ])
  })

  it('counts 与筛选同口径:total 是**企业数**;titles 是符合条件企业各自的称号桶', () => {
    const out = listRosterEnterprises(db, { source: ['jxj'] })
    expect(out.counts.total).toBe(2)
    // 称号桶按**符合条件企业的全部称号**计(与 RL-04 一致,也与 `title` 判据同口径):
    // 甲企业在本筛选下由经信局侧命中,但它的小巨人来自工信部那条记录,仍计入小巨人桶。
    expect(out.counts.titles.innovative_sme).toBe(1)
    expect(out.counts.titles.specialized_sme).toBe(1)
    expect(out.counts.titles.little_giant).toBe(1)
    // titlePairs 是「企业 × 称号」数 ⇒ 可能大于企业数,这是 RL-04 的既定口径。
    expect(out.counts.titlePairs).toBe(3)
  })

  it('与既有筛选叠加(称号 + 来源 + 属地)', () => {
    const rows = listRosterEnterprises(db, {
      title: ['specialized_sme'],
      source: ['miit'],
      district: '北仑区',
    }).rows
    expect(names(rows)).toEqual(['甲企业有限公司'])
  })

  it('导出走同一段实现:allRosterEnterprises 与分页结果同一口径', () => {
    const filter = { source: ['jxj'] as string[] }
    const paged = listRosterEnterprises(db, { ...filter, pageSize: 1 })
    const all = allRosterEnterprises(db, filter)
    expect(all.counts).toEqual(paged.counts)
    expect(all.rows.map((r) => r.enterpriseId)).toEqual(
      listRosterEnterprises(db, { ...filter, pageSize: 50 }).rows.map((r) => r.enterpriseId),
    )
    expect(paged.rows).toHaveLength(1)
  })
})

describe('两种分组在同一批筛选下是同一批企业(合并页切换分组不换人)', () => {
  /**
   * 这是 RL-17 合并页最关键的一条不变量:`按企业` 与 `按企业×称号` 共用一个 URL,
   * 用户在两者之间切换时看到的**企业集合**必须一样 —— 否则「同一个筛选」在两种
   * 分组下给出两批人,合并就只是把两个页面塞进一个页面。
   *
   * 交叉核对的是**两个既有读模型**(`lib/query.listRecords` 与
   * `lib/roster/enterprise-roster.listRosterEnterprises`),不是各自再算一遍。
   */
  const cases: { name: string; filter: Record<string, unknown> }[] = [
    { name: '来源', filter: { source: ['miit'] } },
    { name: '事件类型', filter: { eventType: ['award'] } },
    { name: '年份', filter: { year: [2023] } },
    { name: '称号', filter: { title: ['specialized_sme'] } },
    { name: '称号 + 来源', filter: { title: ['specialized_sme'], source: ['miit'] } },
    { name: '类型 + 年份', filter: { eventType: ['award'], year: [2023] } },
    { name: '来源 + 类型 + 年份', filter: { source: ['jxj'], eventType: ['award'], year: [2021] } },
    { name: '筛不中任何东西', filter: { year: [1999] } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      // `listRecords` 一页最多 200 条;这些小夹具远小于该上限,不会被分页截断。
      const recordRows = listRecords(db, { ...c.filter, pageSize: 200 } as never).rows
      const fromRecords = [...new Set(recordRows.map((r) => r.name))].sort()
      const fromRoster = names(listRosterEnterprises(db, c.filter).rows)
      expect(fromRoster).toEqual(fromRecords)
    })
  }
})

describe('parseRosterEnterpriseQuery —— 新判据的解析与取值校验', () => {
  it('解析多值 source / eventType / year', () => {
    const out = parseRosterEnterpriseQuery({
      source: 'jxj,miit',
      eventType: 'award',
      year: '2021,2022',
    })
    expect(out.source).toEqual(['jxj', 'miit'])
    expect(out.eventType).toEqual(['award'])
    expect(out.year).toEqual([2021, 2022])
  })

  it('缺省时三项都是 undefined(「没筛」与「筛了个空」是两回事)', () => {
    const out = parseRosterEnterpriseQuery({})
    expect(out.source).toBeUndefined()
    expect(out.eventType).toBeUndefined()
    expect(out.year).toBeUndefined()
  })

  it('取值不在字典里 ⇒ 400,不静默放过', () => {
    expect(() => parseRosterEnterpriseQuery({ source: 'nope' })).toThrowError(/source/)
    expect(() => parseRosterEnterpriseQuery({ eventType: 'nope' })).toThrowError(/eventType/)
  })

  it('year 的非数字项被剔除;全非数字时等于没筛', () => {
    expect(parseRosterEnterpriseQuery({ year: '2021,abc' }).year).toEqual([2021])
    expect(parseRosterEnterpriseQuery({ year: 'abc' }).year).toBeUndefined()
  })

  it('字典里的每个合法值都放行(用 labels 的单一来源,不另抄一份)', () => {
    expect(parseRosterEnterpriseQuery({ source: SOURCE_ORDER.join(',') }).source).toEqual(
      SOURCE_ORDER,
    )
    expect(
      parseRosterEnterpriseQuery({ eventType: EVENT_ORDER.join(',') }).eventType,
    ).toEqual(EVENT_ORDER)
  })
})

describe('差异查询:仍不认记录侧判据,但认搜索(合并台账的搜索框对三个视图都生效)', () => {
  it('source / eventType / year 不进差异筛选(它们不是差异的属性)', () => {
    const out = parseRosterDifferenceQuery({ direction: 'missing_in_miit', source: 'miit' })
    expect(out).toEqual({
      q: undefined,
      title: undefined,
      direction: ['missing_in_miit'],
      status: undefined,
      reason: undefined,
      page: 1,
      pageSize: 50,
    })
  })

  it('认 q(否则合并后台账的搜索框在差异视图里是静默不筛)', () => {
    expect(parseRosterDifferenceQuery({ q: '  宁波  ' }).q).toBe('宁波')
  })

  it('差异行按企业名筛;并认**已确认**曾用名', () => {
    const before = listRosterDifferences(db, {})
    expect(before.total).toBeGreaterThan(0)

    const onlyJia = listRosterDifferences(db, { q: '甲企业' })
    expect(onlyJia.total).toBeGreaterThan(0)
    expect(new Set(onlyJia.rows.map((r) => r.name))).toEqual(new Set(['甲企业有限公司']))

    // 未确认的别名不参与(契约 §1.2),确认过的才把这家企业带出来。
    expect(listRosterDifferences(db, { q: '甲记工厂' }).total).toBe(0)
    db.insert(schema.enterpriseAlias)
      .values({
        enterpriseId: ids.jia!,
        name: '甲记工厂',
        nameNorm: '甲记工厂',
        sourceKind: 'platform_business',
        sourceRefId: 1,
        verificationStatus: 'confirmed',
      })
      .run()
    expect(new Set(listRosterDifferences(db, { q: '甲记工厂' }).rows.map((r) => r.name))).toEqual(
      new Set(['甲企业有限公司']),
    )

    // 筛不中任何企业时返回空集,不是退化成不筛。
    expect(listRosterDifferences(db, { q: '不存在的企业' }).total).toBe(0)
  })
})
