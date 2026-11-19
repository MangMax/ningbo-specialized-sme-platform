import { describe, expect, it } from 'vitest'
import { siblingIndex } from '../../../layers/core/lib/core/file-path'
import { getAppModules } from '../../../lib/app-modules'

const scopeOf = getAppModules().find(module => module.id === 'sme-roster')!.fileCategories!.admission

/**
 * RL-16(票 #17)—— 文件库**入库范围规则**的规则层测试。
 *
 * 这些是**纯函数**用例:给一个库内相对路径 + 同目录兄弟名,回答「入不入库、为什么」。
 * 规则被 `layers/core/server/utils/stored-files.ts` 的回填真的用上(见 `stored-file.test.ts` 的
 * 「入库范围」一节)—— 所以这里钉住的是**行为**,不是一份散文。
 *
 * 判据的出处:`lib/file-store-scope.ts` 的「入库范围」一节 +
 * `.agents/skills/roster-ingestion-pipeline/references/decisions.md`。
 */

const SIBLINGS_2023_1 = siblingIndex([
  'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.doc',
  'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx',
  'jxj/announcement/2023/1/关于公布2023年第一批宁波市创新型中小企业名单的通知.doc',
  'jxj/announcement/2023/1/关于公布2023年第一批宁波市创新型中小企业名单的通知.docx',
])

describe('入库范围:在范围内的文件照样入库', () => {
  it('公布文件(PDF)与导出表(xlsx)一律在范围内', () => {
    const dir = siblingIndex([])
    expect(scopeOf('jxj/announcement/2024/1/甬经信中小〔2024〕72号 通知.pdf', dir.get('jxj/announcement/2024/1'))).toMatchObject({ inScope: true, reason: 'in-scope' })
    expect(scopeOf('miit/export/创新型中小企业导出Excel.xlsx')).toMatchObject({ inScope: true, reason: 'in-scope' })
  })

  it('跨年汇总的工作簿(没有年份/批次段)仍在范围内 —— 判据不看年份', () => {
    expect(scopeOf('jxj/announcement/经信局公布历年小巨人企业名单.xlsx')).toMatchObject({ inScope: true })
  })

  it('没有同名兄弟的 .doc 照样入库(它是唯一的一份,转不出 .docx 也不该丢)', () => {
    const dir = siblingIndex(['jxj/announcement/2023/1/只有旧版的通知.doc'])
    expect(scopeOf('jxj/announcement/2023/1/只有旧版的通知.doc', dir.get('jxj/announcement/2023/1'))).toMatchObject({ inScope: true })
  })

  it('由 .doc 转出的 .docx(同目录只有 .doc 兄弟)照样入库 —— 题型是「与 PDF 同名」才排除', () => {
    expect(
      scopeOf(
        'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx',
        SIBLINGS_2023_1.get('jxj/announcement/2023/1'),
      ),
    ).toMatchObject({ inScope: true })
  })
})

describe('入库范围:该排除的三种情形', () => {
  it('文件名含「入库培育」⇒ 排除(培育对象不构成称号)', () => {
    const verdict = scopeOf('jxj/announcement/2021/甬经信中小〔2021〕160号关于公布2021-2022宁波市“专精特新”入库培育企业名单的通知.pdf')
    expect(verdict.inScope).toBe(false)
    expect(verdict.reason).toBe('nurture')
    expect(verdict.detail).toContain('入库培育')
  })

  it('.doc 且有同名 .docx ⇒ 排除(重复件;保留可预览的那份)', () => {
    const verdict = scopeOf(
      'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.doc',
      SIBLINGS_2023_1.get('jxj/announcement/2023/1'),
    )
    expect(verdict.inScope).toBe(false)
    expect(verdict.reason).toBe('duplicate-doc')
  })

  it('.docx 且有同名 .pdf ⇒ 排除(人工 OCR 产物;PDF 才是权威原件)', () => {
    const dir = siblingIndex([
      'jxj/announcement/2022/甬经信中小〔2022〕145号 通知.pdf',
      'jxj/announcement/2022/甬经信中小〔2022〕145号 通知.docx',
    ])
    const verdict = scopeOf(
      'jxj/announcement/2022/甬经信中小〔2022〕145号 通知.docx',
      dir.get('jxj/announcement/2022'),
    )
    expect(verdict.inScope).toBe(false)
    expect(verdict.reason).toBe('human-ocr-docx')
  })

  it('兄弟名只认**同目录**:别的年份目录里有同名 .docx 不影响本目录的判断', () => {
    expect(scopeOf('jxj/announcement/2023/1/通知.doc', new Set(['通知.docx']))).toMatchObject({ inScope: false })
    expect(scopeOf('jxj/announcement/2023/1/通知.doc', new Set(['别的名字.docx']))).toMatchObject({ inScope: true })
    expect(scopeOf('jxj/announcement/2023/1/通知.doc')).toMatchObject({ inScope: true })
  })
})

describe('siblingIndex:按目录归集文件名', () => {
  it('同目录的文件归到一起,不同目录互不影响', () => {
    const index = siblingIndex([
      'jxj/announcement/2024/1/a.pdf',
      'jxj/announcement/2024/1/a.docx',
      'jxj/announcement/2024/2/a.pdf',
    ])
    expect([...index.get('jxj/announcement/2024/1')!].sort()).toEqual(['a.docx', 'a.pdf'])
    expect([...index.get('jxj/announcement/2024/2')!]).toEqual(['a.pdf'])
  })
})
