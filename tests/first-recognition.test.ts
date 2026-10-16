import { describe, expect, it } from 'vitest'
import {
  FIRST_RECOGNITION_PENDING_REASON_VALUES,
  FIRST_RECOGNITION_STATUS_VALUES,
  FIRST_RECOGNITION_UNKNOWN_YEAR,
  evidencePointerText,
  firstRecognitionYearText,
  judgeFirstRecognition,
  matchesRecognitionQuery,
  type FirstRecognitionEvidence,
  type RecognitionEntry,
  type RecognitionEvent,
} from '../lib/roster/first-recognition'
import { computeTitleLifecycle } from '../lib/roster/lifecycle'

/**
 * RL-08 —— **首次认定的口径**(契约 §6.1–§6.3、§7.5,issue #8)。
 *
 * 这一层是纯函数,判的就是票面最容易被写错的那句话:
 *
 * > 首次认定 = 该(**企业 × 称号**)下**最早的那次 `award`**;
 * > 复核通过不是新的首次认定;**复核失败后再次获批也不重置**首次认定。
 *
 * 用例里的年份是**文档里写死的那个回归案例**(契约 §6.3、ADR §4、00-CONTEXT
 * 「关键回归案例」):2021 首次认定 → 2024 复核未通过 → 2025 再次获批 ⇒ 首次仍是 2021。
 * 期望值取自文档,不是照代码推的。
 *
 * 另一条是「历史不完整」:有一条 `award` **定不了年**,它就可能早于已知最早那条 ——
 * 此时**不能**把当前窗口里最早的年份冒充首次,要标待确认(issue #8 验收第 3 条)。
 */

function ev(
  id: number,
  eventType: string,
  year: number | null,
  opts: { decidedYear?: number | null; reviewOutcome?: string | null; source?: string } = {},
): RecognitionEvent {
  return {
    id,
    eventType,
    year,
    decidedYear: opts.decidedYear === undefined ? year : opts.decidedYear,
    reviewOutcome: opts.reviewOutcome ?? null,
    source: opts.source ?? 'jxj',
  }
}

/** 事件的出处(与 `record_evidence` 同形状)。 */
function evd(
  sourceFile: string,
  rest: { attachment?: string | null; listNo?: number | null; page?: number | null } = {},
): FirstRecognitionEvidence {
  return {
    sourceFile,
    attachment: rest.attachment ?? null,
    listNo: rest.listNo ?? null,
    page: rest.page ?? null,
  }
}

/**
 * 判一条(企业 × 称号)。走的是**真实的两段**:`computeTitleLifecycle`(契约 §6 的唯一
 * 一处生命周期计算)+ `judgeFirstRecognition`(首次认定的标注与待确认判定)。
 */
function judge(
  titleCode: string,
  events: RecognitionEvent[],
  evidence: Record<number, FirstRecognitionEvidence[]> = {},
) {
  const lifecycle = computeTitleLifecycle(events)
  return judgeFirstRecognition({
    titleCode,
    lifecycle,
    events,
    evidenceByEvent: new Map(Object.entries(evidence).map(([id, list]) => [Number(id), list])),
  })
}

const AWARD_2021 = evd('jxj/announcement/2022/甬经信中小〔2022〕145号….pdf', {
  attachment: '附件一',
  listNo: 74,
})

describe('首次认定 = 最早的那次 award(按企业 × 称号)', () => {
  it('单次认定:年份、事件 id、来源与出处都给得出来', () => {
    const entry = judge('specialized_sme', [ev(9, 'award', 2021)], { 9: [AWARD_2021] })!
    expect(entry).toEqual({
      titleCode: 'specialized_sme',
      firstYear: 2021,
      firstEventId: 9,
      source: 'jxj',
      status: 'confirmed',
      pendingReason: null,
      evidence: [AWARD_2021],
      undatedAwardIds: [],
    })
  })

  it('跨批次多认定:取**最早**那条,不是最近那条', () => {
    // 回归案例的形状:同一信用代码在第 2 批与第 6 批各出现一次 ⇒ 企业去重、两条事件都留。
    const entry = judge(
      'little_giant',
      [ev(2, 'award', 2020, { source: 'jxj' }), ev(6, 'award', 2024, { source: 'miit' })],
      { 2: [evd('jxj/workbook/小巨人历史名单.xlsx', { listNo: 12 })], 6: [evd('miit/export/2024.xlsx')] },
    )!
    expect(entry.firstYear).toBe(2020)
    expect(entry.firstEventId).toBe(2)
    expect(entry.source).toBe('jxj')
    // 出处是**最早那条**的出处(第 2 批),不是第 6 批的。
    expect(entry.evidence).toEqual([evd('jxj/workbook/小巨人历史名单.xlsx', { listNo: 12 })])
  })

  it('事件顺序不影响结论(同一年按 id 定序)', () => {
    const a = judge('specialized_sme', [ev(3, 'award', 2025), ev(1, 'award', 2021)], { 1: [AWARD_2021] })!
    const b = judge('specialized_sme', [ev(1, 'award', 2021), ev(3, 'award', 2025)], { 1: [AWARD_2021] })!
    expect(a).toEqual(b)
    expect(a.firstEventId).toBe(1)
  })

  it('复核通过**不是**新的首次认定', () => {
    const entry = judge(
      'specialized_sme',
      [ev(1, 'award', 2021), ev(2, 'review', 2021, { decidedYear: 2024 })],
      { 1: [AWARD_2021] },
    )!
    expect(entry.firstYear).toBe(2021)
    expect(entry.firstEventId).toBe(1)
  })

  it('★ 复核失败后再次获批**不重置**首次认定(2021 → 2024 未通过 → 2025 再获批)', () => {
    // 这是本票最容易被写错的一条:2025 又一次 award,首次认定**仍是 2021**。
    const entry = judge(
      'specialized_sme',
      [
        ev(1, 'award', 2021),
        // 被复核的原认定年份是 2021,结论发生在 2024。
        ev(2, 'review', 2021, { decidedYear: 2024 }),
        ev(3, 'award', 2025),
      ],
      { 1: [AWARD_2021], 3: [evd('jxj/announcement/2025/1/关于公布2025年第一批认定….pdf', { listNo: 3 })] },
    )!
    expect(entry.firstYear).toBe(2021)
    expect(entry.firstEventId).toBe(1)
    // 出处也必须是 2021 那次,不能漂到 2025。
    expect(entry.evidence).toEqual([AWARD_2021])
    expect(entry.status).toBe('confirmed')
  })

  it('review 的 reviewOutcome 说「未通过」也不参与首次认定(只看 award)', () => {
    const events = [
      ev(1, 'award', 2021),
      ev(2, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'failed' }),
    ]
    const entry = judge('specialized_sme', events, { 1: [AWARD_2021] })!
    expect(entry.firstYear).toBe(2021)
    expect(entry.firstEventId).toBe(1)
  })

  it('多称号分别算:同一条事件列表里,每个称号各看各的 award', () => {
    // 同一个企业两个称号 ⇒ 两行(企业 × 称号),不是一个企业一行。
    const sme = judge('specialized_sme', [ev(1, 'award', 2021), ev(2, 'award', 2024)], {
      1: [AWARD_2021],
      2: [evd('jxj/announcement/2024/….pdf')],
    })!
    expect(sme.titleCode).toBe('specialized_sme')
    expect(sme.firstYear).toBe(2021)
    expect(sme.firstEventId).toBe(1)
  })

  it('nurture / maintain 不构成称号:**没有 award 就没有首次认定**(返回 null,不是造一行)', () => {
    expect(judge('little_giant', [ev(1, 'nurture', 2023), ev(2, 'maintain', 2025)])).toBeNull()
    expect(judge('little_giant', [])).toBeNull()
  })
})

describe('历史不完整 ⇒ 待确认,不把当前窗口里最早的年份冒充首次', () => {
  it('存在**无法定年**的 award ⇒ 待确认,并指出是哪几条事件', () => {
    // 最早那条 award 定不了年(来源没给年份),另一条是 2024。
    const entry = judge(
      'specialized_sme',
      [ev(1, 'award', null, { decidedYear: null }), ev(2, 'award', 2024)],
      { 2: [evd('jxj/announcement/2024/….pdf')] },
    )!
    // 已知最早那条的年份照给(2024),但**不声称**它是首次。
    expect(entry.firstYear).toBe(2024)
    expect(entry.status).toBe('pending')
    expect(entry.pendingReason).toBe('undated_award')
    // 依据可回到出处:是「#1 这条定不了年」让 2024 不能算首次。
    expect(entry.undatedAwardIds).toEqual([1])
  })

  it('全部 award 都无法定年 ⇒ 年份留空 + 待确认(空值优于一个假年份)', () => {
    const entry = judge('specialized_sme', [
      ev(1, 'award', null, { decidedYear: null }),
      ev(2, 'award', null, { decidedYear: null }),
    ])!
    expect(entry.firstYear).toBeNull()
    expect(entry.firstEventId).toBeNull()
    expect(entry.source).toBeNull()
    expect(entry.status).toBe('pending')
    expect(entry.pendingReason).toBe('no_dated_award')
    expect(entry.undatedAwardIds).toEqual([1, 2])
  })

  it('首次认定那条事件**没有存下来的出处** ⇒ 待确认(依据回不到出处就不能算确立)', () => {
    const entry = judge('specialized_sme', [ev(1, 'award', 2021)])!
    expect(entry.firstYear).toBe(2021)
    expect(entry.evidence).toEqual([])
    expect(entry.status).toBe('pending')
    expect(entry.pendingReason).toBe('no_evidence')
  })

  it('待确认原因有确定优先级:定不了年的年份缺失 > 有无法定年的更早候选 > 没有出处', () => {
    // 三条同时成立时,报最靠前的那条(判据是确定的,不随实现顺序变)。
    const entry = judge('specialized_sme', [
      ev(1, 'award', null, { decidedYear: null }),
      ev(2, 'award', null, { decidedYear: null }),
    ])!
    expect(entry.pendingReason).toBe('no_dated_award')
  })

  it('称号、年份、出处都齐 ⇒ 才是 confirmed(待确认不是「一律标一下」)', () => {
    const entry = judge('specialized_sme', [ev(1, 'award', 2021)], { 1: [AWARD_2021] })!
    expect(entry.status).toBe('confirmed')
    expect(entry.pendingReason).toBeNull()
  })

  it('两态与三因都是可判别取值,且互不等价', () => {
    expect(new Set(FIRST_RECOGNITION_STATUS_VALUES).size).toBe(2)
    expect(new Set(FIRST_RECOGNITION_PENDING_REASON_VALUES).size).toBe(3)
    expect(FIRST_RECOGNITION_PENDING_REASON_VALUES).toEqual([
      'no_dated_award',
      'undated_award',
      'no_evidence',
    ])
  })
})

describe('筛选判据只有一处(企业总表与 §7.5 清单共用)', () => {
  /**
   * 这条判据被两个读模型共用(企业总表按「企业」判、§7.5 清单按行判)。它必须**只有一份**:
   * 各写一遍的话,一边加了条件、另一边没加,于是「总表筛出 3 家、清单筛出 5 家」——
   * 而这两个数在页面上是并排给人看的。
   */
  const entry = (over: Partial<RecognitionEntry> = {}): RecognitionEntry => ({
    titleCode: 'specialized_sme',
    firstYear: 2021,
    firstEventId: 1,
    source: 'jxj',
    status: 'confirmed',
    pendingReason: null,
    evidence: [AWARD_2021],
    undatedAwardIds: [],
    ...over,
  })

  it('没给的项不参与(「没筛」就是全都放过)', () => {
    expect(matchesRecognitionQuery(entry(), {})).toBe(true)
    expect(matchesRecognitionQuery(entry(), { title: [], firstYear: [], firstStatus: [] })).toBe(true)
  })

  it('给的项逐条生效,多值取或', () => {
    expect(matchesRecognitionQuery(entry(), { title: ['specialized_sme'] })).toBe(true)
    expect(matchesRecognitionQuery(entry(), { title: ['innovative_sme'] })).toBe(false)
    expect(matchesRecognitionQuery(entry(), { title: ['innovative_sme', 'specialized_sme'] })).toBe(true)
    expect(matchesRecognitionQuery(entry(), { firstYear: [2021] })).toBe(true)
    expect(matchesRecognitionQuery(entry(), { firstYear: [2022] })).toBe(false)
    expect(matchesRecognitionQuery(entry(), { firstStatus: ['confirmed'] })).toBe(true)
    expect(matchesRecognitionQuery(entry(), { firstStatus: ['pending'] })).toBe(false)
    // 几项之间取与。
    expect(matchesRecognitionQuery(entry(), { firstYear: [2021], firstStatus: ['pending'] })).toBe(false)
  })

  it('★ 年份给不出(`firstYear == null`)时**命中不了任何年份**', () => {
    // 「未知」不是某个具体年份 —— 把它当成命中,等于替它挑了个年份。
    const undated = entry({ firstYear: null, status: 'pending', pendingReason: 'no_dated_award' })
    expect(matchesRecognitionQuery(undated, { firstYear: [2021] })).toBe(false)
    expect(matchesRecognitionQuery(undated, { firstYear: [0] })).toBe(false)
    // 但不给年份判据时它照样在(只按状态筛能筛到它)。
    expect(matchesRecognitionQuery(undated, { firstStatus: ['pending'] })).toBe(true)
  })
})

describe('展示用的两句话也只有一处(导出 / 台账表 / 展开面板共用)', () => {
  it('年份文案:有年份给年份,没有就明说「年份未知」,不留空、不借别的年份', () => {
    expect(firstRecognitionYearText({ firstYear: 2021 })).toBe('2021')
    expect(firstRecognitionYearText({ firstYear: null })).toBe(FIRST_RECOGNITION_UNKNOWN_YEAR)
    // 年份 0 是个值,不是「没有」—— 不能被当成缺失。
    expect(firstRecognitionYearText({ firstYear: 0 })).toBe('0')
  })

  it('出处文案:文件 · 附件 · 序号 · 页,缺哪样不写哪样(不填占位符)', () => {
    expect(evidencePointerText(AWARD_2021)).toBe(
      'jxj/announcement/2022/甬经信中小〔2022〕145号….pdf · 附件一 · 序号 74',
    )
    expect(evidencePointerText({ sourceFile: 'a.pdf', attachment: null, listNo: null, page: null })).toBe('a.pdf')
    expect(evidencePointerText({ sourceFile: 'a.pdf', attachment: '附件三', listNo: 1, page: 88 })).toBe(
      'a.pdf · 附件三 · 序号 1 · 第 88 页',
    )
  })
})

describe('出处可回到「哪个文件 / 哪个附件 / 哪个序号」', () => {
  it('一条事件的多条出处**逐条保留**,不折叠成一条', () => {
    const second = evd('jxj/announcement/2022/甬经信中小〔2022〕145号….pdf', {
      attachment: '附件三',
      listNo: 216,
      page: 88,
    })
    const entry = judge('specialized_sme', [ev(1, 'award', 2021)], { 1: [AWARD_2021, second] })!
    expect(entry.evidence).toEqual([AWARD_2021, second])
  })

  it('页号缺失时留空(不猜),文件 / 附件 / 序号照给', () => {
    const entry = judge('specialized_sme', [ev(1, 'award', 2021)], { 1: [AWARD_2021] })!
    expect(entry.evidence[0]!.page).toBeNull()
    expect(entry.evidence[0]!.sourceFile).toContain('145号')
    expect(entry.evidence[0]!.attachment).toBe('附件一')
    expect(entry.evidence[0]!.listNo).toBe(74)
  })
})
