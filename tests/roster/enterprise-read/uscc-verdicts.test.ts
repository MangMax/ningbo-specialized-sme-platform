import { describe, expect, it } from 'vitest'
import { coreWordOf, isValidUscc, judgeUsccClaim, usccFormatVerdict } from '../../../layers/sme-roster/lib/roster/uscc-research'
import { normalizeUsccVerdicts, type UsccVerdictFile } from '../../../layers/sme-roster/server/utils/uscc-verdicts'

const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'

describe('A · 核心词与统一社会信用代码格式（纯函数）', () => {
  it('去区划前缀 + 去组织形式后缀', () => {
    expect(coreWordOf('宁波上航测绘有限公司')).toBe('上航测绘')
    expect(coreWordOf('宁波市上航测绘股份有限公司')).toBe('上航测绘')
    expect(coreWordOf('浙江瑞堂塑料科技股份有限公司')).toBe('瑞堂塑料科技')
    expect(coreWordOf('浙江省瑞堂塑料科技有限公司')).toBe('瑞堂塑料科技')
    expect(coreWordOf('华裕电器集团股份有限公司')).toBe('华裕电器集团')
    expect(coreWordOf('宁波仁栋电气有限责任公司')).toBe('仁栋电气')
  })

  it('前缀/后缀各只去一次（「宁波宁波」不会一路剥到底）', () => {
    expect(coreWordOf('宁波宁波机械有限公司')).toBe('宁波机械')
  })

  it('抓不出内容时返回空串 —— 不拿全名去猜', () => {
    expect(coreWordOf('')).toBe('')
    expect(coreWordOf(null)).toBe('')
    expect(coreWordOf('宁波')).toBe('')
    expect(coreWordOf('有限公司')).toBe('')
  })

  it('名称里的空白 / 全角空格 / 零宽字符不影响抓取', () => {
    expect(coreWordOf('  宁波上航​测绘有限公司 ')).toBe('上航测绘')
  })

  it('真实统代通过格式与校验位', () => {
    expect(usccFormatVerdict(USCC)).toBe('ok')
    expect(isValidUscc('913302017133602847')).toBe(true)
    expect(isValidUscc('913302067562827060')).toBe(true)
    expect(isValidUscc('91330205084796244Y')).toBe(true)
    expect(isValidUscc('913302126102116572')).toBe(true)
    // 大小写不敏感（来源里常见小写）。
    expect(isValidUscc('91330211255994457p')).toBe(true)
  })

  it('长度 / 字符集 / 校验位分别报出（不合并成一句「非法」）', () => {
    expect(usccFormatVerdict('91330211255994457')).toBe('length')
    expect(usccFormatVerdict('9133021125599445IP')).toBe('charset') // I 不在 GB 32100 字符集里
    // 校验位抄错：把真实的最后一位换成字符集里的另一个。
    expect(usccFormatVerdict('91330211255994457Q')).toBe('checksum')
    expect(isValidUscc(undefined)).toBe(false)
  })

  it('claim：三要素齐备、地区相符、校验位正确 ⇒ 可行', () => {
    expect(
      judgeUsccClaim({
        enterpriseId: 1,
        uscc: USCC,
        source: {
          url: 'https://example.gov.cn/notice/1',
          checkedOn: '2026-10-16',
          basis: '公开名录里该主体名与公布名一致，注册地宁波镇海',
          name: OLD_NAME,
          region: '宁波市/镇海区',
        },
      }),
    ).toEqual({ ok: true })
  })

  it('claim：代码格式不合法 / 三要素不齐 / 地区不符 ⇒ 逐条给理由', () => {
    const base = {
      enterpriseId: 1,
      uscc: USCC,
      source: { url: 'u', checkedOn: '2026-10-16', basis: 'b', name: 'n', region: '宁波市' },
    }
    expect(judgeUsccClaim({ ...base, uscc: '9133021125599445IP' })).toMatchObject({ code: 'uscc_format_invalid' })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, url: '' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, checkedOn: '2026/10/16' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, basis: '  ' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, region: '杭州市' } })).toMatchObject({
      code: 'region_mismatch',
    })
  })
})

describe('导入统代查证判定', () => {
  const batchFile = (items: unknown[], generatedAt = '2026-10-16T16:00:00.000Z') => ({
    file: 'uscc-verdict-batch-9.json',
    value: { batch: 9, generatedAt, items } as UsccVerdictFile,
  })

  it('保留 resolved 的名称匹配标志与未处理判定', () => {
    const outOfScope = 9000
    const ingest = normalizeUsccVerdicts([
      batchFile([
        {
          enterpriseId: outOfScope,
          name: '宁波孤帆远影文创有限公司',
          candidateUscc: '91330212MA2CL6FP2J',
          qymcEqualsAnnouncedName: true,
          verdict: 'resolved',
          platformEvidence: [
            { interface: 'queryl_typo', rdjb: '3', sequenceNo: 1, qymc: '宁波孤帆远影文创有限公司' },
          ],
          reason: '库内命中 + 平台 qymc 逐字相等',
        },
        { enterpriseId: 9001, name: '甲', candidateUscc: null, verdict: 'not_found', reason: '库内与平台都查不到' },
        { enterpriseId: 9002, name: '乙', candidateUscc: '91330211MA2CL6FP24', verdict: 'conflict', reason: '两个候选都自称' },
        { enterpriseId: 9003, name: '丙', candidateUscc: '91330211MA2CL6FP24', verdict: 'needs_human', reason: '会话失败' },
        {
          enterpriseId: 9004,
          name: '丁',
          candidateUscc: '91330211MA2CL6FP24',
          qymcEqualsAnnouncedName: false,
          verdict: 'resolved',
          reason: '名字对不上',
        },
      ]),
    ])
    expect(ingest.batches).toEqual([
      { batch: 9, file: 'uscc-verdict-batch-9.json', generatedAt: '2026-10-16T16:00:00.000Z', items: 5 },
    ])
    // 两条 `resolved` 都进认领（**`qymcEqualsAnnouncedName` 不是判据**，采纳与否只看库里对不对得上；
    // 那三态如实记进 `flagState`）；`interface` 写错的那条证据条目被过滤掉了。
    // 另外三条（not_found / conflict / needs_human）原样列出、不动库。
    expect(ingest.platformClaims).toHaveLength(2)
    expect(ingest.platformClaims[0]).toMatchObject({
      enterpriseId: outOfScope,
      enterpriseName: '宁波孤帆远影文创有限公司',
      uscc: '91330212MA2CL6FP2J',
      batchRef: 'uscc-verdict-batch-9',
      observedAt: '2026-10-16T16:00:00.000Z',
      flagState: 'true',
      evidence: [],
    })
    expect(ingest.platformClaims[1]).toMatchObject({ enterpriseId: 9004, flagState: 'false' })
    // 证据**只做结构过滤、不按名称筛**：平台原文常与公布名只在归一化口径下相等
    //（逐字筛会把整批证据丢光），且同一次返回里的现名行也要留住。
    expect(ingest.platformClaims[1]!.evidence).toEqual([])
    expect(ingest.untouched.map((row) => row.verdict).sort()).toEqual(['conflict', 'needs_human', 'not_found'])
    expect(ingest.untouched.every((row) => 'blocked' in row)).toBe(true)
    expect(ingest.problems).toEqual([])
  })

  it('缺 generatedAt / 缺 candidateUscc / verdict 取值未知 ⇒ 记 problem 并跳过（不猜）', () => {
    const noTime = normalizeUsccVerdicts([
      { file: 'f.json', value: { batch: 1, items: [{ enterpriseId: 1, name: '甲', verdict: 'resolved', candidateUscc: '91330211MA2CL6FP24' }] } as UsccVerdictFile },
    ])
    expect(noTime.platformClaims).toEqual([])
    expect(noTime.problems[0]).toContain('缺 generatedAt')

    const bad = normalizeUsccVerdicts([
      batchFile([
        { enterpriseId: 9101, name: '甲', verdict: 'resolved', candidateUscc: '', qymcEqualsAnnouncedName: true },
        { enterpriseId: 9102, name: '乙', verdict: 'maybe', candidateUscc: '91330211MA2CL6FP24' },
        { name: '丙', verdict: 'resolved', candidateUscc: '91330211MA2CL6FP24' },
      ]),
    ])
    expect(bad.platformClaims).toEqual([])
    expect(bad.problems.join('|')).toContain('缺 candidateUscc')
    expect(bad.problems.join('|')).toContain('verdict 取值未知')
    expect(bad.problems.join('|')).toContain('缺 enterpriseId / name')
    expect(bad.untouched).toEqual([
      { enterpriseId: 9101, name: '甲', verdict: 'needs_human', reason: 'resolved 但没给候选统代', blocked: null },
    ])
  })

  it('★ 联网核实 found ⇒ 公开主体来源认领（URL + 抓取日期 + 对应依据），三要素缺一不采纳', () => {
    const ingest = normalizeUsccVerdicts([
      {
        file: 'uscc-webverify-verdict.json',
        value: {
          generatedAt: '2026-10-16T17:32:00+08:00',
          items: [
            {
              enterpriseId: 244,
              name: '宁波洒哇地咔电器有限公司',
              verdict: 'found',
              candidateUscc: '91330281074914761W',
              sources: [
                {
                  url: 'https://www.chinapp.com/company/12056',
                  fetchedAt: '2026-10-16T17:12:00+08:00',
                  basis: '单企业页:标题与正文均含「宁波洒哇地咔电器有限公司」,表「统一社会信用代码 91330281074914761W」',
                },
              ],
              notes: '名称与代码同页配对且区县(余姚市)一致。',
            },
            {
              // 三要素不齐 ⇒ 不采纳、如实列进「不动库」（不猜）。
              enterpriseId: 261,
              name: '慈溪市振鹏管件有限公司',
              verdict: 'found',
              candidateUscc: '91330282724068481X',
              sources: [{ url: '', fetchedAt: '', basis: '' }],
            },
          ],
        } as UsccVerdictFile,
      },
    ])
    expect(ingest.claims).toHaveLength(1)
    expect(ingest.claims[0]).toMatchObject({
      enterpriseId: 244,
      uscc: '91330281074914761W',
      source: {
        url: 'https://www.chinapp.com/company/12056',
        checkedOn: '2026-10-16',
        name: '宁波洒哇地咔电器有限公司',
      },
    })
    expect(ingest.claims[0]!.source.basis).toContain('统一社会信用代码')
    expect(ingest.claims[0]!.note).toContain('余姚市')
    expect(ingest.platformClaims).toEqual([])
    expect(ingest.untouched.map((row) => row.verdict)).toEqual(['needs_human'])
    expect(ingest.problems.join('|')).toContain('公开来源三要素不齐')
  })

})
