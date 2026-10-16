/**
 * RL-07（票 #7）—— **预览并应用年度名录增量**。
 *
 * 这一层坐在 RL-11 的统一写入 API **之上**（`preflight` / `commit` / `replay` 的语义一个字
 * 都没改），补的是年度更新缺的三件事：
 *
 *  1. 一次年度更新 = **一批**来源文件（最新公布文件 + 三张平台导出表），故载荷包是 `entries[]`；
 *  2. **预览**：逐项分类（新增 / 更新 / 归并 / 无变化 / 冲突 / 重名候选）+ 逐项错误；
 *  3. **总表增减**：叠加新快照之后谁离开当前总表、谁因公布历史留下、谁因接口失败**不得据此删除**。
 *
 * 本文件逐条钉住票面验收：
 *  - 更新前能看到新增 / 更新 / 将移出 / 待核的**数量**，并可逐项对到记录（`items[].ref`）；
 *  - 最新公布文件**追加**正式事件，不覆盖以往认定/复核事件；
 *  - 新平台表形成**新快照**，两个接口重查的差异照实落库；
 *  - 仅由平台引入、从未出现在公布文件、且最新快照里也不在 ⇒ **移出当前总表**（企业行保留）；
 *  - 曾出现在公布文件的企业**不因平台缺失而删除**；
 *  - 相同来源重放**幂等**；失败批次**一行不落**且可重试；
 *  - **接口失败时不得据此应用删除或原因**（`failed` ≠ `no_record`）。
 *
 * 库是**临时库**（`useDb({dbPath})`），种子数据一律走**公开写入 API**走一遍（不直写 SQL），
 * 于是「预览说的」与「提交做的」用的是同一套身份规则。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import type { RosterImportRequest } from '../lib/roster-import-client'
import type { AnnualIncrementBundle } from '../lib/roster/annual-increment'
import { allRosterEnterprises } from '../lib/roster/enterprise-roster'
import { previewAnnualIncrement, validateAnnualBundle } from '../server/utils/roster-annual'
import {
  commitRosterImport,
  preflightRosterImport,
  rosterRowCounts,
} from '../server/utils/roster-import'

const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-annual-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 夹具：一批「去年」的库状态 + 一份「今年」的年度更新包
// ---------------------------------------------------------------------------

/** 统代只当不透明键用（`normalizeUscc` 不校验格式）—— 但取值要一眼能读出来是谁。 */
const U = {
  /** 仅平台引入：在 2025 的专精特新快照里，新快照里没有。 */
  platformOnly: '91330200000000001A',
  /** 有公布历史：jxj 2022 认定 + 在 2025 的专精特新快照里。 */
  announced: '91330200000000002B',
  /** 仅平台引入，但只出现在**创新型**快照里（本次不重拍创新型 ⇒ 不该被移出）。 */
  crossTitle: '91330200000000003C',
  /** 仅平台引入，且**一张快照都没有**（证据不足 ⇒ 不误删）。 */
  noSnapshot: '91330200000000004D',
  /** 归并的规范行（有 jxj 认定）。 */
  canonical: '91330200000000005E',
  /** 本年度新认定企业。 */
  newcomer: '91330200000000007G',
} as const

const NAME = {
  platformOnly: '宁波仅平台企业有限公司',
  announced: '宁波有公布历史企业有限公司',
  crossTitle: '宁波跨称号平台企业有限公司',
  noSnapshot: '宁波无快照平台企业有限公司',
  canonical: '宁波规范行企业有限公司',
  mergeSource: '宁波待并企业有限公司',
  newcomer: '宁波年度新认定企业有限公司',
} as const

/** 平台侧（miit）导入：造出「只由平台引入」的几家企业。 */
function seedPlatform(): RosterImportRequest {
  return {
    idempotencyKey: 'seed/miit/platform-only',
    sourceKind: 'announcement',
    sourceIdentity: 'miit/seed/2025/platform-only',
    payload: {
      announcement: {
        sourceDocument: { source: 'miit', title: '平台侧导入（种子）', docNumber: null },
        records: [
          { enterprise: { name: NAME.platformOnly, uscc: U.platformOnly }, titleCode: 'specialized_sme' },
          { enterprise: { name: NAME.crossTitle, uscc: U.crossTitle }, titleCode: 'innovative_sme' },
          { enterprise: { name: NAME.noSnapshot, uscc: U.noSnapshot }, titleCode: 'specialized_sme' },
          // 无统代的待并企业：归并的**被并方**。
          { enterprise: { name: NAME.mergeSource }, titleCode: 'specialized_sme' },
        ],
      },
    },
  }
}

/** 公布文件侧（jxj）：两家有正式认定历史的企业。 */
function seedAnnouncement(): RosterImportRequest {
  return {
    idempotencyKey: 'seed/jxj/2022/145号',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '2022 年度认定', docNumber: '甬经信中小〔2022〕145号' },
        records: [
          {
            enterprise: { name: NAME.announced, uscc: U.announced },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2022,
                batchSeq: 1,
                evidence: [{ sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf', attachment: '附件1', listNo: 1, page: 3 }],
              },
            ],
          },
          {
            enterprise: { name: NAME.canonical, uscc: U.canonical },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2022,
                batchSeq: 1,
                evidence: [{ sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf', attachment: '附件1', listNo: 2, page: 3 }],
              },
            ],
          },
        ],
      },
    },
  }
}

/** 去年的两张平台导出快照。 */
function seedSnapshot(titleCode: string, year: number, rows: Array<{ uscc: string; name: string }>): RosterImportRequest {
  return {
    idempotencyKey: `seed/export/${titleCode}/${year}`,
    sourceKind: 'platform_export',
    sourceIdentity: `miit/export/${titleCode}-${year}.xlsx`,
    payload: {
      exportSnapshot: {
        titleCode,
        year,
        collectedOn: `${year}-12-31`,
        originalFilename: `${titleCode}-${year}.xlsx`,
        sha256: `sha-${titleCode}-${year}`,
        rows: rows.map((row, index) => ({ sourceRowNo: index + 1, usccRaw: row.uscc, nameRaw: row.name })),
      },
    },
  }
}

/** 种出一个「去年末」的库：6 家企业，两种称号各一张 2025 快照。 */
function seededDb() {
  const db = makeDb()
  for (const request of [
    seedPlatform(),
    seedAnnouncement(),
    seedSnapshot('specialized_sme', 2025, [
      { uscc: U.platformOnly, name: NAME.platformOnly },
      { uscc: U.announced, name: NAME.announced },
    ]),
    seedSnapshot('innovative_sme', 2025, [{ uscc: U.crossTitle, name: NAME.crossTitle }]),
  ]) {
    const result = commitRosterImport(db, request)
    expect(result.status, JSON.stringify(result.items)).toBe('committed')
  }
  return db
}

/** 今年这一批：一份公布文件 + 一张专精特新导出表 + 一次归并。 */
function annualBundle(overrides: Partial<{ snapshotRows: Array<{ uscc: string; name: string }> }> = {}): AnnualIncrementBundle {
  return {
    year: 2026,
    entries: [
      {
        idempotencyKey: 'annual/2026/jxj/192号',
        sourceKind: 'announcement',
        sourceIdentity: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf',
        payload: {
          announcement: {
            sourceDocument: { source: 'jxj', title: '2026 年度认定', docNumber: '甬经信中小〔2026〕192号' },
            records: [
              {
                enterprise: { name: NAME.newcomer, uscc: U.newcomer },
                titleCode: 'specialized_sme',
                events: [
                  {
                    eventType: 'award',
                    year: 2026,
                    batchSeq: 1,
                    evidence: [{ sourceFile: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf', attachment: '附件1', listNo: 1, page: 5 }],
                  },
                ],
              },
              {
                // 老企业：**追加**一条 2026 复核事件，历史认定事件一条不动。
                enterprise: { name: NAME.announced, uscc: U.announced },
                titleCode: 'specialized_sme',
                events: [
                  {
                    eventType: 'review',
                    year: 2022,
                    decidedYear: 2026,
                    reviewOutcome: 'passed',
                    evidence: [{ sourceFile: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf', attachment: '附件1', listNo: 9, page: 6 }],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        idempotencyKey: 'annual/2026/export/specialized_sme',
        sourceKind: 'platform_export',
        sourceIdentity: 'miit/export/2026/specialized_sme.xlsx',
        payload: {
          exportSnapshot: {
            titleCode: 'specialized_sme',
            year: 2026,
            collectedOn: '2026-10-01',
            originalFilename: 'specialized_sme-2026.xlsx',
            sha256: 'sha-specialized_sme-2026',
            // 今年的导出表里**只有**新认定的那家：去年的两家（一家有公布历史、一家只由平台
            // 引入）都不在里面 —— 这正是年度更新要处置的「平台缺失」情形。
            rows: (overrides.snapshotRows ?? [{ uscc: U.newcomer, name: NAME.newcomer }]).map((row, index) => ({
              sourceRowNo: index + 1,
              usccRaw: row.uscc,
              nameRaw: row.name,
            })),
          },
        },
      },
      {
        idempotencyKey: 'annual/2026/merge/待并企业',
        sourceKind: 'alias_evidence',
        sourceIdentity: 'jxj/announcement/2026/merge-待并企业',
        payload: {
          merges: [
            {
              fromEnterpriseName: NAME.mergeSource,
              intoUscc: U.canonical,
              aliasName: NAME.mergeSource,
              sourceKind: 'manual',
              note: '年度增量里的身份归并',
            },
          ],
        },
      },
    ],
  }
}

/** `rosterRowCounts` 是 `Record<string, number>`；按 `noUncheckedIndexedAccess` 取值要兜一下。 */
const at = (counts: Record<string, number>, key: string): number => counts[key] ?? 0

/** 今年这批里加一次**失败**的平台重查(针对「仅平台」那家);只记录失败,不据此下结论。 */
function failedQueryBundle(): AnnualIncrementBundle {
  const bundle = annualBundle()
  bundle.entries[0]!.payload.platformQueries = [
    {
      interface: 'business_list',
      queryKey: U.platformOnly,
      rdjb: '2',
      queriedAt: '2026-10-01T02:00:00.000Z',
      status: 'failed',
      failureReason: '登录超时',
    },
  ]
  return bundle
}

/** 把一批（除指定项外）都提交掉 —— 用于验证「预览 = 提交」。 */
function commitBundle(db: ReturnType<typeof makeDb>, bundle: AnnualIncrementBundle, skip: number[] = []) {
  const results = []
  for (const [index, request] of bundle.entries.entries()) {
    if (skip.includes(index)) continue
    const result = commitRosterImport(db, request)
    expect(result.status, `entry ${index}: ${JSON.stringify(result.items)}`).toBe('committed')
    results.push(result)
  }
  return results
}

// ---------------------------------------------------------------------------
// 1. 预览 = 提交（预检说会怎样，提交后就真的怎样，逐项可对）
// ---------------------------------------------------------------------------

describe('RL-07 · 预览 = 提交', () => {
  it('逐项分类与计数，与提交后的可观察结果逐项对上', () => {
    const db = seededDb()
    const bundle = annualBundle()
    const preview = previewAnnualIncrement(db, bundle)

    // 逐项分类：新增（新企业那条记录）、无变化（老企业已有那条记录坐标）、
    // 导出快照新增、归并。
    const entry0 = preview.entries[0]!
    expect(entry0.items.map((item) => item.class)).toEqual(['add', 'unchanged'])
    expect(entry0.items[0]!.enterpriseName).toBe(NAME.newcomer)
    expect(entry0.items[1]!.enterpriseName).toBe(NAME.announced)
    expect(entry0.counts).toMatchObject({ add: 1, update: 0, merge: 0, unchanged: 1, conflicts: 0, review: 0 })
    expect(entry0.batchStatus).toBe('none')
    expect(entry0.willApply).toBe(true)

    const entry1 = preview.entries[1]!
    expect(entry1.items.map((item) => item.class)).toEqual(['add'])
    expect(entry1.items[0]!.kind).toBe('export_batch')

    const entry2 = preview.entries[2]!
    expect(entry2.items.map((item) => item.class)).toEqual(['merge'])
    expect(entry2.counts.merge).toBe(1)

    // ⚠️ `update: 1` 是**归并那一项**：契约 §8.5 把 `merges` 的计划项也记进 `update`
    // （它确实更新了规范行），所以 `update` 与 `merge` 在归并上各记一次。这里如实照抄
    // §8.5 的口径（下一条用例还会拿预检逐项对一遍），页面则按**分类**逐项显示。
    expect(preview.totals).toMatchObject({ add: 2, update: 1, merge: 1, unchanged: 1, conflicts: 0, review: 0 })
    expect(preview.applyable).toBe(true)
    expect(preview.blockedReason).toBeNull()

    // —— 提交 ——
    const before = rosterRowCounts(db)
    commitBundle(db, bundle)
    const after = rosterRowCounts(db)

    // 预览说 add=2（两条「新增」计划项 = 一条企业记录 + 一张快照批），提交后确实各多一行。
    expect(at(after, 'record') - at(before, 'record')).toBe(1)
    expect(at(after, 'platform_export_batch') - at(before, 'platform_export_batch')).toBe(1)
    // 企业表净增 0：本批新建 1 家（今年新认定）、归并删掉 1 家（被并方）——
    // 两个方向各自可复核，所以下面还按名字点了名。
    expect(at(after, 'enterprise') - at(before, 'enterprise')).toBe(0)
    // 事件一条都没丢：新增 2026 认定 + 追加 2026 复核。
    expect(at(after, 'record_event') - at(before, 'record_event')).toBe(2)

    // 提交后的读侧：新企业进当前总表；被并企业只剩一行（规范行）。
    const rows = db.select().from(schema.enterprise).all()
    expect(rows.some((row) => row.name === NAME.newcomer)).toBe(true)
    expect(rows.some((row) => row.name === NAME.mergeSource)).toBe(false)
  })

  it('预览与 §8.1 的预检**报同样的数**（同一份计划，不另立口径）', () => {
    const db = seededDb()
    const bundle = annualBundle()
    const preview = previewAnnualIncrement(db, bundle)
    for (const [index, request] of bundle.entries.entries()) {
      const preflight = preflightRosterImport(db, request).preflight
      const entry = preview.entries[index]!
      expect({ add: preflight.add, update: preflight.update, merge: entry.counts.merge === 0 ? 0 : preflight.remove, review: preflight.review, evidenceRepoints: preflight.evidenceRepoints }).toEqual({
        add: entry.counts.add,
        update: entry.counts.update,
        merge: entry.counts.merge,
        review: entry.counts.review,
        evidenceRepoints: entry.counts.evidenceRepoints,
      })
    }
  })

  it('最新公布文件**追加**正式事件，不覆盖以往认定/复核事件', () => {
    const db = seededDb()
    const bundle = annualBundle()
    commitBundle(db, bundle)

    const enterprise = db.select().from(schema.enterprise).all().find((row) => row.name === NAME.announced)!
    const record = db.select().from(schema.record).all().find((row) => row.enterpriseId === enterprise.id)!
    const events = db
      .select()
      .from(schema.recordEvent)
      .all()
      .filter((event) => event.recordId === record.id)
      .sort((a, b) => a.id - b.id)
    expect(events.map((event) => [event.eventType, event.year, event.decidedYear, event.reviewOutcome])).toEqual([
      ['award', 2022, null, null],
      ['review', 2022, 2026, 'passed'],
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. 总表增减：谁移出、谁保留、谁待核
// ---------------------------------------------------------------------------

describe('RL-07 · 总表增减', () => {
  it('仅由平台引入、从未出现在公布文件、且最新快照里也不在 ⇒ 将移出当前总表', () => {
    const db = seededDb()
    const roster = previewAnnualIncrement(db, annualBundle()).roster
    expect(roster.removed.map((row) => row.name)).toEqual([NAME.platformOnly])
    expect(roster.removed[0]!.uscc).toBe(U.platformOnly)
    // 「上次出现在哪张表」要能看见（可复核的正证据）。
    expect(roster.removed[0]!.snapshot).toMatchObject({ titleCode: 'specialized_sme', year: 2025 })
    expect(roster.counts.removed).toBe(1)
  })

  it('曾出现在正式公布文件的企业不因平台缺失而删除', () => {
    const db = seededDb()
    const roster = previewAnnualIncrement(db, annualBundle()).roster
    expect(roster.keptByAnnouncement.map((row) => row.name)).toEqual([NAME.announced])
    expect(roster.removed.some((row) => row.name === NAME.announced)).toBe(false)
  })

  it('别的称号的快照没被重拍 ⇒ 那张快照仍然是它的锚点，不移出', () => {
    const db = seededDb()
    const roster = previewAnnualIncrement(db, annualBundle()).roster
    const touched = [
      ...roster.removed.map((row) => row.name),
      ...roster.blocked.map((row) => row.name),
      ...roster.keptByAnnouncement.map((row) => row.name),
    ]
    expect(touched).not.toContain(NAME.crossTitle)
  })

  it('一张快照都没有的企业不因「无从证明」被删（证据不足不误删）', () => {
    const db = seededDb()
    const roster = previewAnnualIncrement(db, annualBundle()).roster
    const touched = [
      ...roster.removed.map((row) => row.name),
      ...roster.blocked.map((row) => row.name),
      ...roster.keptByAnnouncement.map((row) => row.name),
    ]
    expect(touched).not.toContain(NAME.noSnapshot)
  })

  it('本批公布文件给某平台企业建了 jxj 记录 ⇒ 它不再算移出', () => {
    const db = seededDb()
    const bundle = annualBundle()
    // 把「仅平台」那家写进今年的公布文件（今年才认定的情形）。
    const announcement = bundle.entries[0]!
    announcement.payload.announcement!.records!.push({
      enterprise: { name: NAME.platformOnly, uscc: U.platformOnly },
      titleCode: 'specialized_sme',
      events: [
        {
          eventType: 'award',
          year: 2026,
          batchSeq: 1,
          evidence: [{ sourceFile: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf', attachment: '附件1', listNo: 20, page: 9 }],
        },
      ],
    })
    const roster = previewAnnualIncrement(db, bundle).roster
    expect(roster.removed).toHaveLength(0)
    expect(roster.keptByAnnouncement.map((row) => row.name)).toContain(NAME.platformOnly)

    // 提交后按读侧口径复核：它仍在当前总表（有 jxj 记录）。
    commitBundle(db, bundle)
    const snapshot = previewAnnualIncrement(db, { year: 2026, entries: [] })
    expect(snapshot.entries).toEqual([])
  })

  it('提交之后按读侧口径复核：移出的那家确实变成 removed_platform_only，其余不变', () => {
    const db = seededDb()
    const bundle = annualBundle()
    const roster = previewAnnualIncrement(db, bundle).roster
    commitBundle(db, bundle)

    const rows = allRosterEnterprises(db).rows
    const stateOf = (name: string) => rows.find((row) => row.name === name)!.rosterState
    expect(stateOf(NAME.platformOnly)).toBe('removed_platform_only')
    expect(stateOf(NAME.announced)).toBe('current')
    expect(stateOf(NAME.crossTitle)).toBe('current')
    expect(stateOf(NAME.noSnapshot)).toBe('current')
    expect(roster.counts.removed).toBe(1)
  })
})

describe('RL-07 · 多张平台表(真实年度形状)', () => {
  it('一次年度更新可以带多张导出表：各按**自己的称号**认最新，该移出的都移出', () => {
    const db = seededDb()
    const bundle = annualBundle()
    // 真实形状:三张表 = 三个 entry(§8.3 的 exportSnapshot 一次只装一张)。
    bundle.entries.push({
      idempotencyKey: 'annual/2026/export/innovative_sme',
      sourceKind: 'platform_export',
      sourceIdentity: 'miit/export/2026/innovative_sme.xlsx',
      payload: {
        exportSnapshot: {
          titleCode: 'innovative_sme',
          year: 2026,
          collectedOn: '2026-10-01',
          originalFilename: 'innovative_sme-2026.xlsx',
          sha256: 'sha-innovative_sme-2026',
          // 今年这张创新型表里**没有**去年那家 ⇒ 它同样失去锚点。
          rows: [],
        },
      },
    })
    const preview = previewAnnualIncrement(db, bundle)
    expect(preview.entries).toHaveLength(4)
    expect(preview.roster.removed.map((row) => row.name)).toEqual([NAME.platformOnly, NAME.crossTitle].sort((a, b) => a.localeCompare(b, 'zh')))
    expect(preview.roster.keptByAnnouncement.map((row) => row.name)).toEqual([NAME.announced])

    commitBundle(db, bundle)
    const counted = rosterRowCounts(db)
    expect(at(counted, 'platform_export_batch')).toBe(4) // 种库 2 张 + 今年 2 张(新旧并存)
  })
})

// ---------------------------------------------------------------------------
// 3. 接口失败：不得据此应用删除或原因
// ---------------------------------------------------------------------------

describe('RL-07 · 接口失败不得据此删除或原因', () => {

  it('重查失败的企业列入**待核**，不计入「将移出」', () => {
    const db = seededDb()
    const bundle = failedQueryBundle()
    const roster = previewAnnualIncrement(db, bundle).roster
    expect(roster.removed).toHaveLength(0)
    expect(roster.blocked.map((row) => row.name)).toEqual([NAME.platformOnly])
    expect(roster.counts).toEqual({ removed: 0, blocked: 1, keptByAnnouncement: 1 })
  })

  it('拿失败查询当证据去写「已确认原因」⇒ 整批不落一行，逐项错误点明是查询失败', () => {
    const db = seededDb()
    const bundle = annualBundle()
    bundle.entries[0]!.payload.platformQueries = [
      {
        interface: 'business_list',
        queryKey: U.platformOnly,
        rdjb: '2',
        queriedAt: '2026-10-01T02:00:00.000Z',
        status: 'failed',
        failureReason: '登录超时',
      },
    ]
    bundle.entries[0]!.payload.differences = [
      {
        uscc: U.platformOnly,
        titleCode: 'specialized_sme',
        direction: 'extra_in_miit',
        status: 'confirmed_reason',
        reasonCode: 'moved_out',
        measureCode: 'mark_moved_out',
        verificationStatus: 'confirmed',
        recordedAt: '2026-10-01T03:00:00.000Z',
        evidenceQueryRef: { interface: 'business_list', queryKey: U.platformOnly, rdjb: '2' },
      },
    ]
    const preview = previewAnnualIncrement(db, bundle)
    const conflict = preview.entries[0]!.items.find((item) => !item.ok)
    expect(conflict?.error?.code).toBe('evidence_query_failed')
    expect(preview.applyable).toBe(false)
    expect(preview.totals.conflicts).toBe(1)

    const before = rosterRowCounts(db)
    const result = commitRosterImport(db, bundle.entries[0]!)
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ written: 0, failed: 1 })
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('★ 独立审查点出的计数口径:冲突项**不**同时计入「无变化」', () => {
    const db = seededDb()
    const bundle = annualBundle()
    // 这一项会整批失败(规范行不存在),而计划里失败项的 `action` 是 `skip` ——
    // 不加 `ok` 判据就会被数第二遍,于是页面上「无变化 1 / 冲突 1」讲的是同一行。
    bundle.entries[0]!.payload.merges = [{ fromEnterpriseName: NAME.platformOnly, intoUscc: '91330299999999999Z' }]
    const preview = previewAnnualIncrement(db, bundle)
    const entry0 = preview.entries[0]!
    // 这一项里:一条新增记录 + 一条命中既有坐标的记录 + 一条冲突的归并。
    expect(entry0.counts).toMatchObject({ add: 1, unchanged: 1, merge: 0, conflicts: 1 })
    // **分类与计数一一对应**:每一类(`item.class`)的数量就是那一桶的数 —— 冲突项
    // 只算在冲突里,不再被 `action:'skip'` 带进「无变化」。
    const byClass = (code: string) => entry0.items.filter((item) => item.class === code).length
    expect(byClass('conflict')).toBe(entry0.counts.conflicts)
    expect(byClass('unchanged')).toBe(entry0.counts.unchanged)
    expect(byClass('merge')).toBe(entry0.counts.merge)
    expect(preview.applyable).toBe(false)

    // 极端一点的形状:**整项只有一条冲突** ⇒ 「无变化」必须是 0(修之前是 1)。
    const onlyConflict = previewAnnualIncrement(db, {
      year: 2026,
      entries: [
        {
          idempotencyKey: 'annual/2026/merge-only-conflict',
          sourceKind: 'alias_evidence',
          sourceIdentity: 'jxj/merge-only',
          payload: { merges: [{ fromEnterpriseName: NAME.platformOnly, intoUscc: '91330299999999999Z' }] },
        },
      ],
    })
    expect(onlyConflict.entries[0]!.counts).toMatchObject({ add: 0, unchanged: 0, merge: 0, conflicts: 1 })
  })

  it('★ 独立审查点出的口径:被挡住的只是**原因**,移出本身照样发生', () => {
    const db = seededDb()
    const bundle = failedQueryBundle()
    // 只记录失败(不据此下结论)⇒ 可以应用,没有冲突。
    const preview = previewAnnualIncrement(db, bundle)
    expect(preview.totals.conflicts).toBe(0)
    expect(preview.applyable).toBe(true)
    expect(preview.roster.blocked.map((row) => row.name)).toEqual([NAME.platformOnly])

    // 但应用之后,按读侧口径复核:这家**确实**离开了当前总表(成员资格是派生的,
    // 上面那一次重查失败不在派生判据里)——
    // 页面因此必须写成「不得据此**写原因**」而不是「不会移出」,并且在应用之前把这句话说出来。
    commitBundle(db, bundle)
    const rows = allRosterEnterprises(db).rows
    expect(rows.find((row) => row.name === NAME.platformOnly)!.rosterState).toBe('removed_platform_only')
    // 而且**一条原因都没写下来**(失败的结果不落成结论)。
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })

  it('**如实记录失败本身**（query_failed + manual_review）仍然写得进去', () => {
    const db = seededDb()
    const bundle = annualBundle()
    bundle.entries[0]!.payload.platformQueries = [
      {
        interface: 'business_list',
        queryKey: U.platformOnly,
        rdjb: '2',
        queriedAt: '2026-10-01T02:00:00.000Z',
        status: 'failed',
        failureReason: '登录超时',
      },
    ]
    bundle.entries[0]!.payload.differences = [
      {
        uscc: U.platformOnly,
        titleCode: 'specialized_sme',
        direction: 'extra_in_miit',
        status: 'query_failed',
        measureCode: 'manual_review',
        verificationStatus: 'pending',
        recordedAt: '2026-10-01T03:00:00.000Z',
        evidenceQueryRef: { interface: 'business_list', queryKey: U.platformOnly, rdjb: '2' },
      },
    ]
    const preview = previewAnnualIncrement(db, bundle)
    expect(preview.totals.conflicts).toBe(0)
    const result = commitRosterImport(db, bundle.entries[0]!)
    expect(result.status).toBe('committed')
    const difference = db.select().from(schema.differenceReason).all()
    expect(difference).toHaveLength(1)
    expect(difference[0]!.status).toBe('query_failed')
    expect(difference[0]!.verificationStatus).toBe('pending')
  })
})

describe('RL-07 · 刷新接口原因 / 措施及其证据', () => {
  it('重查**成功且有记录** ⇒ platform_stale + mark_platform_snapshot，且证据指到那次查询', () => {
    const db = seededDb()
    const bundle = annualBundle()
    // 平台未更新(契约 §2.8):公布名单里有、导出表里没有,但**接口查得到**关系 ⇒ 不是「无记录」。
    bundle.entries[0]!.payload.platformQueries = [
      {
        interface: 'business_list',
        queryKey: U.announced,
        rdjb: '2',
        queriedAt: '2026-10-01T02:00:00.000Z',
        status: 'success',
        relations: [
          {
            sequenceNo: 1,
            relationKey: 'SQ-2026-1',
            usccRaw: U.announced,
            nameRaw: NAME.announced,
            matchBasis: 'uscc',
            verificationStatus: 'confirmed',
          },
        ],
      },
    ]
    bundle.entries[0]!.payload.differences = [
      {
        uscc: U.announced,
        titleCode: 'specialized_sme',
        direction: 'missing_in_miit',
        status: 'confirmed_reason',
        reasonCode: 'platform_stale',
        measureCode: 'mark_platform_snapshot',
        verificationStatus: 'confirmed',
        recordedAt: '2026-10-01T03:00:00.000Z',
        evidenceQueryRef: { interface: 'business_list', queryKey: U.announced, rdjb: '2' },
      },
    ]
    const preview = previewAnnualIncrement(db, bundle)
    expect(preview.totals.conflicts).toBe(0)
    const differenceItem = preview.entries[0]!.items.find((item) => item.kind === 'difference')
    expect(differenceItem).toMatchObject({ class: 'add', ok: true, enterpriseName: NAME.announced })

    expect(commitRosterImport(db, bundle.entries[0]!).status).toBe('committed')
    const query = db.select().from(schema.platformQuery).all()[0]!
    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference).toMatchObject({
      status: 'confirmed_reason',
      reasonCode: 'platform_stale',
      measureCode: 'mark_platform_snapshot',
      verificationStatus: 'confirmed',
      // **证据指针**落在那次查询上(刷新证据 = 这一列指到新的查询行)。
      evidenceQueryId: query.id,
    })
  })
})

describe('RL-07 · 票面点名要覆盖的差异情形', () => {
  it('外地迁入(带别的称号批次)与注销:原因、措施与迁入承载都落得下来', () => {
    const db = seededDb()
    const bundle = annualBundle()
    bundle.entries[0]!.payload.platformQueries = [
      {
        interface: 'apply_list',
        queryKey: U.platformOnly,
        queriedAt: '2026-10-01T02:00:00.000Z',
        status: 'no_record',
      },
      {
        interface: 'business_list',
        queryKey: U.crossTitle,
        rdjb: '2',
        queriedAt: '2026-10-01T02:05:00.000Z',
        status: 'no_record',
      },
    ]
    bundle.entries[0]!.payload.differences = [
      {
        // **外地迁入**:迁入尽量记原城市、称号、年份、批次;查不到留空待核,不猜。
        uscc: U.crossTitle,
        titleCode: 'innovative_sme',
        direction: 'extra_in_miit',
        status: 'confirmed_reason',
        reasonCode: 'moved_in',
        measureCode: 'record_moved_in',
        verificationStatus: 'confirmed',
        recordedAt: '2026-10-01T03:00:00.000Z',
        evidenceQueryRef: { interface: 'business_list', queryKey: U.crossTitle, rdjb: '2' },
        movedIn: { city: '绍兴市', titleCode: 'specialized_sme', year: 2024, batch: 2 },
      },
      {
        // **公司注销**。
        uscc: U.platformOnly,
        titleCode: 'specialized_sme',
        direction: 'extra_in_miit',
        status: 'confirmed_reason',
        reasonCode: 'deregistered',
        measureCode: 'mark_deregistered',
        verificationStatus: 'confirmed',
        recordedAt: '2026-10-01T03:01:00.000Z',
        evidenceQueryRef: { interface: 'apply_list', queryKey: U.platformOnly },
      },
    ]
    // 那张 business_list 查询的键要指到迁入的那家(逐字匹配统代)。
    bundle.entries[0]!.payload.platformQueries[1]!.queryKey = U.crossTitle

    const preview = previewAnnualIncrement(db, bundle)
    expect(preview.totals.conflicts).toBe(0)
    expect(commitRosterImport(db, bundle.entries[0]!).status).toBe('committed')

    const diffs = db.select().from(schema.differenceReason).all()
    const movedIn = diffs.find((row) => row.reasonCode === 'moved_in')!
    expect(movedIn).toMatchObject({
      measureCode: 'record_moved_in',
      verificationStatus: 'confirmed',
      movedInCity: '绍兴市',
      movedInTitleCode: 'specialized_sme',
      movedInYear: 2024,
      movedInBatch: 2,
    })
    expect(diffs.find((row) => row.reasonCode === 'deregistered')).toMatchObject({
      measureCode: 'mark_deregistered',
      status: 'confirmed_reason',
    })
  })
})

// ---------------------------------------------------------------------------
// 4. 幂等、失败可重试、以及「不得谎报」
// ---------------------------------------------------------------------------

describe('RL-07 · 幂等 / 可追溯 / 不谎报', () => {
  it('同一来源重放不产生第二遍效果（业务表一行不变，预览如实报「无变化」）', () => {
    const db = seededDb()
    const bundle = annualBundle()
    commitBundle(db, bundle)
    const after = rosterRowCounts(db)

    // 再提交同一批：幂等键已 committed ⇒ **直接返回既有摘要、一行不写**（§8.2）。
    // 注意返回的是**当时那次**的摘要（所以这里 `written` 不是 0）—— 幂等的证据是
    // 「业务表一行没变」，而那正是下一行断言的。
    const original = db
      .select()
      .from(schema.importBatch)
      .all()
      .find((row) => row.idempotencyKey === bundle.entries[0]!.idempotencyKey)!
    const replay = commitRosterImport(db, bundle.entries[0]!)
    expect(replay.status).toBe('committed')
    expect(replay.batchId).toBe(original.id)
    expect(replay.summary).toEqual(original.summary)
    expect(rosterRowCounts(db)).toEqual(after)

    // 预览对已提交的键**如实报零**，并说明为什么点应用也不会写。
    const preview = previewAnnualIncrement(db, bundle)
    const entry0 = preview.entries[0]!
    expect(entry0.batchStatus).toBe('committed')
    expect(entry0.willApply).toBe(false)
    expect(entry0.counts).toMatchObject({ add: 0, update: 0, merge: 0, unchanged: 0, conflicts: 0, evidenceRepoints: 0 })
    expect(entry0.items).toEqual([])

    // 三项都提交过 ⇒ 整包不可应用，理由是「幂等」而不是「无事可做」。
    const all = previewAnnualIncrement(db, { year: 2026, entries: bundle.entries })
    expect(all.applyable).toBe(false)
    expect(all.blockedReason).toContain('/replay')
  })

  it('失败可重试：修好载荷后按同一幂等键重来，只写一遍', () => {
    const db = seededDb()
    const bundle = annualBundle()
    const broken = structuredClone(bundle.entries[0]!) as RosterImportRequest
    // 制造一个冲突：归并到一个不存在的规范行。
    broken.payload.merges = [{ fromEnterpriseName: NAME.platformOnly, intoUscc: '91330299999999999Z' }]
    const failed = commitRosterImport(db, broken)
    expect(failed.status).toBe('failed')
    const batch = db.select().from(schema.importBatch).all().find((row) => row.idempotencyKey === broken.idempotencyKey)!
    expect(batch.status).toBe('failed')
    // 失败项逐条可查（可追溯）。
    expect((batch.itemResults as Array<{ ok: boolean }>).some((item) => !item.ok)).toBe(true)

    const fixed = commitRosterImport(db, bundle.entries[0]!)
    expect(fixed.status).toBe('committed')
    expect(fixed.batchId).toBe(batch.id)
    const rows = db.select().from(schema.enterprise).all()
    expect(rows.filter((row) => row.name === NAME.newcomer)).toHaveLength(1)
  })

  it('预览**一行都不写**（连批次记账都不落，所以永远不会覆写已提交批次的账）', () => {
    const db = seededDb()
    const bundle = annualBundle()
    const batchesBefore = db.select().from(schema.importBatch).all().length
    const rowsBefore = rosterRowCounts(db)

    previewAnnualIncrement(db, bundle)
    previewAnnualIncrement(db, bundle)
    expect(db.select().from(schema.importBatch).all().length).toBe(batchesBefore)
    expect(rosterRowCounts(db)).toEqual(rowsBefore)

    // 已提交之后再来预览，也不许改动那条批次的记账。
    commitBundle(db, bundle)
    const committed = db.select().from(schema.importBatch).all().find((row) => row.idempotencyKey === bundle.entries[0]!.idempotencyKey)!
    previewAnnualIncrement(db, bundle)
    const reread = db.select().from(schema.importBatch).all().find((row) => row.id === committed.id)!
    expect(reread.preflightResult).toEqual(committed.preflightResult)
    expect(reread.summary).toEqual(committed.summary)
    expect(reread.status).toBe('committed')
  })
})

// ---------------------------------------------------------------------------
// 5. 载荷包校验
// ---------------------------------------------------------------------------

describe('RL-07 · 载荷包校验', () => {
  it('包内每一项都走 §8.1 的同一份校验', () => {
    expect(validateAnnualBundle({ year: 2026, entries: [] })).toMatchObject({ ok: false, status: 400 })
    expect(validateAnnualBundle({ entries: [{ idempotencyKey: 'x' }] })).toMatchObject({ ok: false, status: 400 })
    const single = validateAnnualBundle(annualBundle().entries[0])
    expect(single.ok).toBe(true)
    const wrapped = validateAnnualBundle(annualBundle())
    expect(wrapped.ok).toBe(true)
    if (wrapped.ok) expect(wrapped.value.entries).toHaveLength(3)
  })
})
