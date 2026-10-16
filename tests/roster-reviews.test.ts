/**
 * RL-09 下一年度复核清单(契约 §6 / §7.4)的**领域口径**用例。
 *
 * 这一层测的是「清单凭什么把这家列进来」,所以断言全部落在**用户可观察的行与原因**上
 * (企业 / 称号 / 锚点年份 / 到期年份 / 锚点事件 / 批次 / 来源 / 出处),不绑定内部函数名。
 *
 * 边界用例逐条对着票面 #9 的验收写:
 *  - 2021 认定 → 2024 到期(恰好第 3 年进清单);
 *  - 2024 复核通过 → 2027 到期(复核通过刷新锚点);
 *  - 2024 复核失败 → **两条清单都不进**(资格已终止,不是「待确认」);
 *  - 2025 再次获批 → 2028 到期,且**首次认定仍是 2021**;
 *  - 从未复核 → 按认定年 + 3;
 *  - 无认定事件 → 两条清单都不进(没有资格可复核);
 *  - 年份 / 批次 / 出处 / 复核结论证据不全 → 进**待确认**清单,并给出可判别的原因。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import {
  REVIEW_PENDING_REASON_VALUES,
  collectReviewCandidates,
  listRosterReviews,
  type ReviewPendingRow,
  type ReviewRow,
} from '../lib/roster/review-list'

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-reviews-'))
const db = useDb({ dbPath: join(dir, 'reviews.db') })

afterAll(() => rmSync(dir, { recursive: true, force: true }))

type TitleCode = 'little_giant' | 'specialized_sme' | 'innovative_sme'

function enterprise(name: string, uscc: string | null = null, district: string | null = '鄞州区') {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function record(enterpriseId: number, titleCode: TitleCode, source: 'jxj' | 'miit' = 'jxj') {
  return db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source, district: '鄞州区' })
    .returning({ id: schema.record.id })
    .get().id
}

interface EventSpec {
  eventType: 'award' | 'review' | 'maintain' | 'nurture'
  /** 事件**所涉**年份:认定事件是认定年;复核事件是**被复核的原认定年份**。 */
  year?: number | null
  /** **结论年份**。缺失即「来源没给」—— 不退化成猜。 */
  decidedYear?: number | null
  reviewOutcome?: 'passed' | 'failed' | null
  batchSeq?: number | null
  /** 是否给这条事件写出处。默认给;显式 `false` 用来造「证据不全」。 */
  evidence?: boolean
}

/** 写一条事件;默认带一条出处(`…/第3批.pdf` 附件二 序号7 第9页)。 */
function event(recordId: number, spec: EventSpec) {
  const id = db
    .insert(schema.recordEvent)
    .values({
      recordId,
      eventType: spec.eventType,
      year: spec.year ?? null,
      batchSeq: spec.batchSeq === undefined ? 3 : spec.batchSeq,
      sortKey: spec.year ?? 0,
      decidedYear: spec.decidedYear ?? null,
      reviewOutcome: spec.reviewOutcome ?? null,
    })
    .returning({ id: schema.recordEvent.id })
    .get().id
  if (spec.evidence !== false) {
    db.insert(schema.recordEvidence)
      .values({
        recordEventId: id,
        sourceFile: `jxj/announcement/2021/第3批.pdf`,
        attachment: '附件二',
        listNo: 7,
        page: 9,
      })
      .run()
  }
  return id
}

const byName = (rows: (ReviewRow | ReviewPendingRow)[], name: string) =>
  rows.filter((r) => r.name === name)

const due = (year: number, extra: { title?: string[] } = {}) =>
  collectReviewCandidates(db, { year, ...extra }).due

const pending = (year: number, extra: { title?: string[] } = {}) =>
  collectReviewCandidates(db, { year, ...extra }).pending

// ---------------------------------------------------------------------------
// 票面「验收」点名的两组边界
// ---------------------------------------------------------------------------

describe('三年复核到期:恰好第 3 年进清单,第 4 年不进', () => {
  const id = enterprise('宁波恰好第三年有限公司', '91330211AAAAAA101X')
  const rec = record(id, 'specialized_sme')
  const awardId = event(rec, { eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1 })

  it('2024 年(锚点 + 3)在清单里,并说明依据是 2021 那次认定', () => {
    const rows = byName(due(2024), '宁波恰好第三年有限公司')
    expect(rows).toHaveLength(1)
    const row = rows[0] as ReviewRow
    expect(row.titleCode).toBe('specialized_sme')
    expect(row.anchorYear).toBe(2021)
    expect(row.dueYear).toBe(2024)
    expect(row.basisEventId).toBe(awardId)
    expect(row.basisEventType).toBe('award')
    expect(row.firstYear).toBe(2021)
    // 出处:能回到具体文件 / 附件 / 序号 / 页 —— 不允许只给一个名单。
    expect(row.evidence).toEqual([
      { sourceFile: 'jxj/announcement/2021/第3批.pdf', attachment: '附件二', listNo: 7, page: 9 },
    ])
    expect(row.source).toBe('jxj')
    expect(row.batchSeq).toBe(1)
  })

  it('2025 年(第 4 年)不问「2021 认定」这一批 —— 它到期在 2024', () => {
    expect(byName(due(2025), '宁波恰好第三年有限公司')).toHaveLength(0)
  })

  it('2023 年(锚点 + 2,还没到期)也不进清单', () => {
    expect(byName(due(2023), '宁波恰好第三年有限公司')).toHaveLength(0)
  })
})

describe('复核结论改变锚点:通过 / 失败 / 再次获批', () => {
  const passId = enterprise('宁波复核通过有限公司', '91330211AAAAAA102X')
  const recPass = record(passId, 'specialized_sme')
  event(recPass, { eventType: 'award', year: 2021, decidedYear: 2021 })
  const reviewPassId = event(recPass, {
    eventType: 'review',
    year: 2021, // 被复核的原认定年份
    decidedYear: 2024, // 结论发生在 2024
    reviewOutcome: 'passed',
  })

  const failId = enterprise('宁波复核失败有限公司', '91330211AAAAAA103X')
  const recFail = record(failId, 'specialized_sme')
  event(recFail, { eventType: 'award', year: 2021, decidedYear: 2021 })
  event(recFail, { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' })

  const againId = enterprise('宁波再次获批有限公司', '91330211AAAAAA104X')
  const recAgain = record(againId, 'specialized_sme')
  event(recAgain, { eventType: 'award', year: 2021, decidedYear: 2021 })
  event(recAgain, { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' })
  const reAwardId = event(recAgain, { eventType: 'award', year: 2025, decidedYear: 2025 })

  it('2024 复核通过 ⇒ 下一次到期 2027(锚点是那次复核,不是原认定)', () => {
    const row = byName(due(2027), '宁波复核通过有限公司')[0] as ReviewRow
    expect(row).toBeDefined()
    expect(row.anchorYear).toBe(2024)
    expect(row.dueYear).toBe(2027)
    expect(row.basisEventId).toBe(reviewPassId)
    // 复核通过**不是**新的首次认定。
    expect(row.firstYear).toBe(2021)
  })

  it('2024 复核通过 ⇒ 不再出现在 2024 的清单里(锚点已被刷新)', () => {
    expect(byName(due(2024), '宁波复核通过有限公司')).toHaveLength(0)
  })

  it('2024 复核失败 ⇒ 两条清单都不进(资格已终止,不是「待确认」)', () => {
    expect(byName(due(2024), '宁波复核失败有限公司')).toHaveLength(0)
    expect(byName(due(2027), '宁波复核失败有限公司')).toHaveLength(0)
    expect(byName(pending(2024), '宁波复核失败有限公司')).toHaveLength(0)
    expect(byName(pending(2027), '宁波复核失败有限公司')).toHaveLength(0)
  })

  it('2025 再次获批 ⇒ 2028 到期,但首次认定仍是 2021', () => {
    const rows = byName(due(2028), '宁波再次获批有限公司')
    expect(rows).toHaveLength(1)
    const row = rows[0] as ReviewRow
    expect(row.anchorYear).toBe(2025)
    expect(row.dueYear).toBe(2028)
    expect(row.basisEventId).toBe(reAwardId)
    expect(row.firstYear).toBe(2021)
    expect(row.firstEventId).not.toBe(reAwardId)
  })

  it('2025 再次获批 ⇒ 2025 的清单里没有它(还没到期)', () => {
    expect(byName(due(2025), '宁波再次获批有限公司')).toHaveLength(0)
  })
})

describe('从未复核 / 无认定事件', () => {
  const neverId = enterprise('宁波从未复核有限公司', '91330211AAAAAA105X')
  const recNever = record(neverId, 'specialized_sme')
  const neverAward = event(recNever, { eventType: 'award', year: 2022, decidedYear: 2022 })

  const noneId = enterprise('宁波只入库培育有限公司', '91330211AAAAAA106X')
  const recNone = record(noneId, 'specialized_sme')
  event(recNone, { eventType: 'nurture', year: 2021, decidedYear: 2021 })
  event(recNone, { eventType: 'maintain', year: 2024 })

  it('从未复核 ⇒ 按唯一那次认定 + 3 到期', () => {
    const row = byName(due(2025), '宁波从未复核有限公司')[0] as ReviewRow
    expect(row).toBeDefined()
    expect(row.anchorYear).toBe(2022)
    expect(row.basisEventId).toBe(neverAward)
  })

  it('没有认定/复核事件 ⇒ 两条清单都不进(入库培育、维护不构成称号有效期)', () => {
    expect(byName(due(2024), '宁波只入库培育有限公司')).toHaveLength(0)
    expect(byName(pending(2024), '宁波只入库培育有限公司')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 证据不全 ⇒ 待确认(隔离,不靠文件名猜)
// ---------------------------------------------------------------------------

describe('证据不全时进入待确认清单,并给出可判别的原因', () => {
  const iso = (name: string, uscc: string, titleCode: TitleCode = 'specialized_sme') => {
    const id = enterprise(name, uscc)
    return { id, rec: record(id, titleCode) }
  }

  it('锚点事件缺批次序号 ⇒ no_batch(不用文件名推批次)', () => {
    const { rec } = iso('宁波缺批次有限公司', '91330211AAAAAA107X')
    event(rec, { eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: null })
    const row = byName(pending(2024), '宁波缺批次有限公司')[0] as ReviewPendingRow
    expect(row).toBeDefined()
    expect(row.reasons).toEqual(['no_batch'])
    // 年份仍算得出,但**只作为暂定值**给出,供人工判断。
    expect(row.tentativeDueYear).toBe(2024)
    expect(byName(due(2024), '宁波缺批次有限公司')).toHaveLength(0)
  })

  it('锚点事件没有出处 ⇒ no_evidence(回不到来源)', () => {
    const { rec } = iso('宁波缺出处有限公司', '91330211AAAAAA108X')
    event(rec, { eventType: 'award', year: 2021, decidedYear: 2021, evidence: false })
    const row = byName(pending(2024), '宁波缺出处有限公司')[0] as ReviewPendingRow
    expect(row.reasons).toEqual(['no_evidence'])
  })

  it('有认定事件但没有任何年份 ⇒ no_anchor_year(算不出到期,不猜)', () => {
    const { rec } = iso('宁波缺年份有限公司', '91330211AAAAAA109X')
    event(rec, { eventType: 'award', year: null, decidedYear: null })
    const row = byName(pending(2024), '宁波缺年份有限公司')[0] as ReviewPendingRow
    expect(row).toBeDefined()
    expect(row.reasons).toEqual(['no_anchor_year'])
    expect(row.anchorYear).toBeNull()
    expect(row.tentativeDueYear).toBeNull()
  })

  it('复核结论未知 ⇒ review_outcome_unknown(资格是被延续还是被终止,未知)', () => {
    const { rec } = iso('宁波结论未知有限公司', '91330211AAAAAA110X')
    event(rec, { eventType: 'award', year: 2022, decidedYear: 2022 })
    event(rec, { eventType: 'review', year: 2022, decidedYear: null, reviewOutcome: null })
    const row = byName(pending(2025), '宁波结论未知有限公司')[0] as ReviewPendingRow
    expect(row).toBeDefined()
    expect(row.reasons).toContain('review_outcome_unknown')
    // 结论未知时**不猜成通过**,所以这里不会凭空多出一个 2025 的到期行。
    expect(byName(due(2025), '宁波结论未知有限公司')).toHaveLength(0)
  })

  it('复核通过但缺结论年份 ⇒ review_year_unconfirmed(退回的 year 是被复核年份,不是结论年)', () => {
    const { rec } = iso('宁波复核缺结论年有限公司', '91330211AAAAAA111X')
    event(rec, { eventType: 'award', year: 2021, decidedYear: 2021 })
    event(rec, { eventType: 'review', year: 2021, decidedYear: null, reviewOutcome: 'passed' })
    const row = byName(pending(2024), '宁波复核缺结论年有限公司')[0] as ReviewPendingRow
    expect(row).toBeDefined()
    expect(row.reasons).toContain('review_year_unconfirmed')
  })

  it('锚点更早的那次未知结论复核不影响锚点 ⇒ 仍在到期清单(后来的认定已重立资格)', () => {
    const { rec } = iso('宁波旧复核未知有限公司', '91330211AAAAAA112X')
    event(rec, { eventType: 'award', year: 2021, decidedYear: 2021 })
    event(rec, { eventType: 'review', year: 2021, decidedYear: null, reviewOutcome: null })
    event(rec, { eventType: 'award', year: 2025, decidedYear: 2025 })
    // 锚点 = 2025 的再次认定 ⇒ 2028 到期;2021 那次未知结论的复核早于锚点,被后来的认定盖过。
    const row = byName(due(2028), '宁波旧复核未知有限公司')[0] as ReviewRow
    expect(row).toBeDefined()
    expect(row.anchorYear).toBe(2025)
  })

  it('多处证据不全 ⇒ 原因逐条列出,不只报第一条', () => {
    const { rec } = iso('宁波多处不全有限公司', '91330211AAAAAA113X')
    event(rec, { eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: null, evidence: false })
    const row = byName(pending(2024), '宁波多处不全有限公司')[0] as ReviewPendingRow
    expect(row.reasons).toEqual(['no_batch', 'no_evidence'])
  })

  it('待确认原因是**可判别**的字典取值,不是随手拼的字符串', () => {
    expect([...REVIEW_PENDING_REASON_VALUES].sort()).toEqual(
      ['no_anchor_year', 'no_batch', 'no_evidence', 'review_outcome_unknown', 'review_year_unconfirmed'],
    )
  })
})

// ---------------------------------------------------------------------------
// 筛选 / 计数 / 分页
// ---------------------------------------------------------------------------

describe('称号筛选、计数与分页', () => {
  const A = enterprise('宁波筛选甲有限公司', '91330211AAAAAA114X')
  const aRec = record(A, 'specialized_sme')
  event(aRec, { eventType: 'award', year: 2024, decidedYear: 2024 })

  const B = enterprise('宁波筛选乙有限公司', '91330211AAAAAA115X')
  const bRec = record(B, 'innovative_sme')
  event(bRec, { eventType: 'award', year: 2024, decidedYear: 2024 })

  it('按称号筛:只留该称号的行', () => {
    const all = due(2027)
    expect(byName(all, '宁波筛选甲有限公司')).toHaveLength(1)
    expect(byName(all, '宁波筛选乙有限公司')).toHaveLength(1)

    const only = due(2027, { title: ['innovative_sme'] })
    expect(byName(only, '宁波筛选甲有限公司')).toHaveLength(0)
    expect(byName(only, '宁波筛选乙有限公司')).toHaveLength(1)
  })

  it('计数先于分页,且分得出到期 / 待确认与各称号', () => {
    const r = collectReviewCandidates(db, { year: 2027, title: ['innovative_sme'] })
    expect(r.counts.due).toBe(1)
    expect(r.counts.titles.innovative_sme?.due).toBe(1)
    expect(r.counts.titles.specialized_sme?.due ?? 0).toBe(0)
  })

  it('分页:第一页按每页 1 条取,第二页取到另一条,两者合起来等于总数', () => {
    const p1 = listRosterReviews(db, { year: 2027, page: 1, pageSize: 1 })
    const p2 = listRosterReviews(db, { year: 2027, page: 2, pageSize: 1 })
    expect(p1.rows).toHaveLength(1)
    expect(p2.rows).toHaveLength(1)
    expect(p1.rows[0]!.enterpriseId).not.toBe(p2.rows[0]!.enterpriseId)
    expect(p1.counts.due).toBe(p2.counts.due)
    expect(p1.counts.due).toBeGreaterThanOrEqual(2)
  })

  it('status=pending 时把待确认行放在 pending 里,rows 为空', () => {
    const r = listRosterReviews(db, { year: 2024, status: 'pending', pageSize: 200 })
    expect(Array.isArray(r.rows)).toBe(true)
    expect(r.rows).toHaveLength(0)
    expect(r.pending.length).toBe(r.counts.pending)
  })
})

describe('一企多称号:同一企业在不同称号上分别成行', () => {
  const id = enterprise('宁波双称号有限公司', '91330211AAAAAA116X')
  const a = record(id, 'specialized_sme')
  const b = record(id, 'innovative_sme')
  event(a, { eventType: 'award', year: 2024, decidedYear: 2024 })
  event(b, { eventType: 'award', year: 2025, decidedYear: 2025 })

  it('两个称号各自按自己的锚点到期', () => {
    expect(byName(due(2027), '宁波双称号有限公司')).toHaveLength(1)
    expect(byName(due(2028), '宁波双称号有限公司')).toHaveLength(1)
    const row = byName(due(2028), '宁波双称号有限公司')[0] as ReviewRow
    expect(row.titleCode).toBe('innovative_sme')
  })
})
