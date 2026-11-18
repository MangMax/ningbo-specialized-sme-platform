import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_PAGE_WORDS,
  evidencePageState,
  evidencePreviewHref,
  isPageCapable,
  isSafeBackPath,
  parseEvidencePreviewQuery,
  planEvidencePages as planEvidencePagesWithCount,
  type EvidencePageCandidate,
  type EvidencePageEntry,
} from '../../../lib/roster/evidence-page'

/**
 * RL-10 —— 出处页码的纯判据(写入侧定位 + 读侧三态 + 跳转链接)。
 *
 * 本文件钉的是**票面最核心的那条约束**:页码必须指向 PDF 实际页,而**裸序号会定位到
 * 错的公司**。夹具用的是真实形状 —— `甬经信中小〔2022〕145号` 附件里三张分节名单,
 * 序号各自从 1 起算(一、198 行;二、104 行;三、413 行,共 715 家),
 * 库里 `record_evidence` 只有 `(source_file, attachment, list_no)`,**分节没有列**。
 *
 * 下列 `listNo` 的重数都是从真库(`data/roster.db`)里数出来的:序号 6 / 65 / 104
 * 各自命中 **3** 条。
 */

const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'

/** This focused pure-rule fixture uses the source notice's known 23-page count. */
function planEvidencePages(entries: readonly EvidencePageEntry[], rows: readonly EvidencePageCandidate[]) {
  return planEvidencePagesWithCount(entries, rows, new Map([[F145, 23]]))
}

/** 真库里 145号 的三条「序号 6」—— 三条都是海曙区,分属三张分节名单。 */
function candidates(): EvidencePageCandidate[] {
  return [
    { evidenceId: 1, sourceFile: F145, listNo: 6, enterpriseId: 101, enterpriseName: '宁波培源股份有限公司', district: '海曙区', enterpriseDistrict: '海曙区', page: null },
    { evidenceId: 2, sourceFile: F145, listNo: 6, enterpriseId: 204, enterpriseName: '宁波开诚生态技术有限公司', district: '海曙区', enterpriseDistrict: '海曙区', page: null },
    { evidenceId: 3, sourceFile: F145, listNo: 6, enterpriseId: 217, enterpriseName: '宁波恒特汽车零部件有限公司', district: '海曙区', enterpriseDistrict: '海曙区', page: null },
    // 同一份文件里的两家近似名(附件一 序号 65 / 附件三 序号 104)—— 都不能被对方吸走。
    { evidenceId: 4, sourceFile: F145, listNo: 65, enterpriseId: 65, enterpriseName: '宁波力劲科技有限公司', district: '北仑区', enterpriseDistrict: '北仑区', page: null },
    { evidenceId: 5, sourceFile: F145, listNo: 104, enterpriseId: 405, enterpriseName: '宁波力劲机械有限公司', district: '北仑区', enterpriseDistrict: '北仑区', page: null },
  ]
}

describe('planEvidencePages —— 分节定位(裸序号一律拒收)', () => {
  it('只给裸序号 ⇒ 拒收,并说清为什么(145号 同序号 3 条)', () => {
    const plan = planEvidencePages([{ sourceFile: F145, listNo: 6, page: 8 }], candidates())

    expect(plan.assignments).toEqual([])
    expect(plan.pending).toHaveLength(1)
    expect(plan.pending[0]!.reason).toBe('entry_incomplete')
    expect(plan.pending[0]!.detail).toContain('145号')
  })

  it('序号 + 企业名 ⇒ 只落到那一家;同序号另两条一个字没动', () => {
    const plan = planEvidencePages(
      [{ sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司', basis: '人工核对页图:附件二第 6 行' }],
      candidates(),
    )

    expect(plan.pending).toEqual([])
    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0]).toMatchObject({ evidenceId: 2, page: 8, previous: null })
  })

  it('序号 + 企业名对不上时**留空待核**,并把「同序号有几条」报出来(分节探针)', () => {
    const plan = planEvidencePages(
      [{ sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波不存在的企业有限公司' }],
      candidates(),
    )

    expect(plan.assignments).toEqual([])
    expect(plan.pending[0]!.reason).toBe('no_match')
    // 3 条 —— 这就是「同序号不同分节」的形状;报告读得出它不是「库里没有」。
    expect(plan.pending[0]!.sameListNo).toBe(3)
    expect(plan.pending[0]!.candidateIds).toEqual([1, 2, 3])
    expect(plan.pending[0]!.detail).toContain('3 条')
  })

  it('同一份文件里的两家近似名不会被互相吸走(力劲科技 / 力劲机械)', () => {
    const plan = planEvidencePages(
      [
        { sourceFile: F145, listNo: 65, page: 5, enterpriseName: '宁波力劲科技有限公司' },
        { sourceFile: F145, listNo: 104, page: 14, enterpriseName: '宁波力劲机械有限公司' },
        // 近似名 + 错的序号:必须留空,而不是退而求其次落到「力劲机械」那条上。
        { sourceFile: F145, listNo: 65, page: 14, enterpriseName: '宁波力劲机械有限公司' },
      ],
      candidates(),
    )

    expect(plan.assignments.map((a) => [a.evidenceId, a.page])).toEqual([
      [4, 5],
      [5, 14],
    ])
    expect(plan.pending).toHaveLength(1)
    expect(plan.pending[0]!.reason).toBe('no_match')
  })

  it('用 enterpriseId 定位同样有效,不受全角/半角括号影响(葛洲坝展慈)', () => {
    const rows: EvidencePageCandidate[] = [
      { evidenceId: 9, sourceFile: F145, listNo: 65, enterpriseId: 262, enterpriseName: '葛洲坝展慈(宁波)金属工业有限公司', district: '慈溪市', enterpriseDistrict: '慈溪市', page: null },
    ]
    const plan = planEvidencePages(
      [{ sourceFile: F145, listNo: 65, page: 10, enterpriseName: '葛洲坝展慈（宁波）金属工业有限公司' }],
      rows,
    )
    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0]!.evidenceId).toBe(9)
  })

  it('district 能给候选进一步收窄', () => {
    const rows: EvidencePageCandidate[] = [
      { evidenceId: 7, sourceFile: F145, listNo: 20, enterpriseId: 300, enterpriseName: '宁波甲乙丙有限公司', district: '海曙区', enterpriseDistrict: '海曙区', page: null },
      { evidenceId: 8, sourceFile: F145, listNo: 20, enterpriseId: 301, enterpriseName: '宁波甲乙丙有限公司', district: '慈溪市', enterpriseDistrict: '慈溪市', page: null },
    ]
    const ok = planEvidencePages(
      [{ sourceFile: F145, listNo: 20, page: 4, enterpriseId: 301, district: '慈溪市' }],
      rows,
    )
    expect(ok.assignments.map((a) => a.evidenceId)).toEqual([8])

    // 不给 district 就**不猜**:两条候选并列 ⇒ ambiguous。
    const ambiguous = planEvidencePages([{ sourceFile: F145, listNo: 20, page: 4, enterpriseName: '宁波甲乙丙有限公司' }], rows)
    expect(ambiguous.assignments).toEqual([])
    expect(ambiguous.pending[0]!.reason).toBe('ambiguous')
    expect(ambiguous.pending[0]!.candidateIds).toEqual([7, 8])
  })

  it('★ 属地按「有效属地」认:记录上的对不上、**企业自身**的对得上,也算命中', () => {
    // 界面上给人看的属地是「有效属地」,它**优先取企业自身的**(见
    // `lib/roster/enterprise-roster.ts` 的 `effectiveDistrict`)。调用方多半照着界面抄,
    // 只认记录上的那一个,就会让一条看起来完全正确的条目莫名其妙 `no_match`。
    const rows: EvidencePageCandidate[] = [
      {
        evidenceId: 30,
        sourceFile: F145,
        listNo: 70,
        enterpriseId: 900,
        enterpriseName: '宁波属地测试有限公司',
        district: null, // 记录没写属地
        enterpriseDistrict: '江北区', // 企业自身写了
        page: null,
      },
    ]
    const plan = planEvidencePages(
      [{ sourceFile: F145, listNo: 70, page: 12, enterpriseId: 900, district: '江北区' }],
      rows,
    )
    expect(plan.pending).toEqual([])
    expect(plan.assignments.map((a) => a.evidenceId)).toEqual([30])

    // 两边都不是这个属地 ⇒ 仍然留空待核。
    const miss = planEvidencePages(
      [{ sourceFile: F145, listNo: 70, page: 12, enterpriseId: 900, district: '象山县' }],
      rows,
    )
    expect(miss.assignments).toEqual([])
    expect(miss.pending[0]!.reason).toBe('no_match')
  })

  it('page 不是 ≥1 的整数 ⇒ 拒收,不取整也不当成「没有页码」', () => {
    for (const bad of [0, -1, 2.5, 'x', null, undefined]) {
      const plan = planEvidencePages(
        [{ sourceFile: F145, listNo: 6, page: bad as number, enterpriseName: '宁波开诚生态技术有限公司' }],
        candidates(),
      )
      expect(plan.assignments).toEqual([])
      expect(plan.pending[0]!.reason).toBe('page_invalid')
    }
  })

  it('源 PDF 实际页数未知时保留 page_count_unknown,没有页数证据就不分配', () => {
    const plan = planEvidencePagesWithCount(
      [{ sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司' }],
      candidates(),
      new Map([[F145, null]]),
    )

    expect(plan.assignments).toEqual([])
    expect(plan.pending[0]!.reason).toBe('page_count_unknown')
  })

  it('非 PDF(Word / Excel)拒绝写页码 —— 这类来源没有可复核的「第 N 页」', () => {
    const rows: EvidencePageCandidate[] = [
      {
        evidenceId: 11,
        sourceFile: 'miit/export/专精特新中小企业导出Excel.xlsx',
        listNo: 3,
        enterpriseId: 5,
        enterpriseName: '宁波某公司',
        district: null,
        enterpriseDistrict: null,
        page: null,
      },
    ]
    const plan = planEvidencePages(
      [{ sourceFile: 'miit/export/专精特新中小企业导出Excel.xlsx', listNo: 3, page: 7, enterpriseName: '宁波某公司' }],
      rows,
    )
    expect(plan.assignments).toEqual([])
    expect(plan.pending[0]!.reason).toBe('not_page_capable')
  })

  it('两条入参抢同一行且页码矛盾 ⇒ 两条都不写(不留一条没依据的页码)', () => {
    const plan = planEvidencePages(
      [
        { sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司' },
        { sourceFile: F145, listNo: 6, page: 9, enterpriseName: '宁波开诚生态技术有限公司' },
      ],
      candidates(),
    )
    expect(plan.assignments).toEqual([])
    expect(plan.pending).toHaveLength(2)
    expect(plan.pending.every((p) => p.reason === 'ambiguous')).toBe(true)
    // ★ 待核项里的 `sameListNo` 报的仍是**同 (文件, 序号) 在库里一共几条**(分节探针),
    // 不是「这条冲突涉及几行」。145号 的序号 6 是 3 条 —— 写死 1 就等于把这个探针关掉。
    expect(plan.pending.map((p) => p.sameListNo)).toEqual([3, 3])
    expect(plan.pending.every((p) => p.candidateIds.length === 1)).toBe(true)
  })

  it('同一行被重复写同一个页码 ⇒ 照写(幂等重跑的常见形状)', () => {
    const plan = planEvidencePages(
      [
        { sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司' },
        { sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司' },
      ],
      candidates(),
    )
    expect(plan.assignments).toHaveLength(2)
    expect(plan.pending).toEqual([])
  })

  it('已是同一个页码 ⇒ previous 与 page 相同,调用方据此报「空操作」', () => {
    const rows = candidates().map((c) => (c.evidenceId === 2 ? { ...c, page: 8 } : c))
    const plan = planEvidencePages(
      [{ sourceFile: F145, listNo: 6, page: 8, enterpriseName: '宁波开诚生态技术有限公司' }],
      rows,
    )
    expect(plan.assignments[0]!.previous).toBe(8)
    expect(plan.assignments[0]!.page).toBe(8)
  })
})

describe('evidencePageState —— 「本来就没有页」与「还没定」是两回事', () => {
  it('PDF 有页码 ⇒ assigned;PDF 没页码 ⇒ pending(待核);Word/Excel ⇒ unavailable', () => {
    expect(evidencePageState(F145, 8)).toBe('assigned')
    expect(evidencePageState(F145, null)).toBe('pending')
    expect(evidencePageState('jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx', null)).toBe('unavailable')
    expect(evidencePageState('miit/export/专精特新中小企业导出Excel.xlsx', null)).toBe('unavailable')
  })

  it('★ 非 PDF 即使被塞了一个 page 值,也仍然「没有页」—— 不许照那个数字跳到猜测页', () => {
    const docx = 'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx'
    expect(evidencePageState(docx, 5)).toBe('unavailable')
    expect(evidencePageState('miit/export/专精特新中小企业导出Excel.xlsx', 5)).toBe('unavailable')
  })

  it('两种「空」的字不一样 —— 合成一个「空」会让「还没做」看着像「不用做」', () => {
    expect(EVIDENCE_PAGE_WORDS.pending).toBe('页码待核')
    expect(EVIDENCE_PAGE_WORDS.unavailable).toBe('—')
  })

  it('isPageCapable 只认 pdf(大小写无关,查询串不算扩展名)', () => {
    expect(isPageCapable(F145)).toBe(true)
    expect(isPageCapable('a/b/c.PDF')).toBe(true)
    expect(isPageCapable('a/b/c.pdf?v=1')).toBe(true)
    expect(isPageCapable('a/b/c.docx')).toBe(false)
    expect(isPageCapable('a/b/c.xlsx')).toBe(false)
    expect(isPageCapable('a/b/c')).toBe(false)
  })
})

describe('跳转链接 —— 出处 → 预览页', () => {
  it('带页码的链接把 file / page / back 都编进去(中文、书名号、空格都能往返)', () => {
    const back = '/roster?view=enterprise&q=宁波&page=2&expand=204'
    const href = evidencePreviewHref({ sourceFile: F145, page: 8, back })

    expect(href.startsWith('/preview?')).toBe(true)
    const parsed = parseEvidencePreviewQuery(Object.fromEntries(new URL(href, 'http://x').searchParams))
    expect(parsed).toEqual({ file: F145, page: 8, back })
  })

  it('没有页码时**不写** page 参数 —— 不假装知道第几页', () => {
    const href = evidencePreviewHref({ sourceFile: F145, page: null, back: '/roster' })
    expect(href).not.toContain('page=')
    expect(parseEvidencePreviewQuery(Object.fromEntries(new URL(href, 'http://x').searchParams)).page).toBeNull()
  })

  it('★ 非 PDF 的链接里永远没有 page —— Word / Excel 不给猜测页', () => {
    const docx = 'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx'
    const href = evidencePreviewHref({ sourceFile: docx, page: 5, back: '/roster' })
    expect(href).not.toContain('page=')
    expect(parseEvidencePreviewQuery(Object.fromEntries(new URL(href, 'http://x').searchParams)).page).toBeNull()
  })

  it('非法 back 一律不写进链接(只认站内相对路径)', () => {
    for (const bad of ['//evil.example.com/x', 'https://evil.example.com', 'javascript:alert(1)', '', null]) {
      const href = evidencePreviewHref({ sourceFile: F145, page: 1, back: bad as string })
      expect(href).not.toContain('back=')
      expect(isSafeBackPath(bad)).toBe(false)
    }
    expect(isSafeBackPath('/')).toBe(true)
    expect(isSafeBackPath('/roster?view=title')).toBe(true)
  })

  it('返回目标拒绝控制字符和解析后跨源的 URL,并保留合法站内路径', () => {
    const appOrigin = 'https://app.example'
    const unsafe = [
      '/\t/other.example/path',
      '/\u0000?view=enterprise',
      '/\u007f/path',
      '/\u0085/path',
      '//other.example/path',
      '/\\other.example/path',
      'https://other.example/path',
    ]

    for (const back of unsafe) {
      expect(isSafeBackPath(back, appOrigin), JSON.stringify(back)).toBe(false)
      expect(parseEvidencePreviewQuery({ file: F145, back }).back, JSON.stringify(back)).toBe('')
      expect(evidencePreviewHref({ sourceFile: F145, page: 8, back })).not.toContain('back=')
    }

    const valid = '/roster?view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91'
    expect(isSafeBackPath(valid, appOrigin)).toBe(true)
    expect(parseEvidencePreviewQuery({ back: valid }).back).toBe(valid)
  })

  it('解析端:坏 page 丢掉而不是夹到边界(不把坏参数变成「第 1 页」)', () => {
    for (const bad of ['0', '-3', 'abc', '2.5', '']) {
      expect(parseEvidencePreviewQuery({ file: F145, page: bad }).page).toBeNull()
    }
    expect(parseEvidencePreviewQuery({ file: F145, page: '3' }).page).toBe(3)
    expect(parseEvidencePreviewQuery({ file: F145, page: ['4', '5'] }).page).toBe(4)
    expect(parseEvidencePreviewQuery({ file: F145, back: '//evil' }).back).toBe('')
    expect(parseEvidencePreviewQuery(undefined)).toEqual({ file: '', page: null, back: '' })
  })
})
