import { describe, expect, it } from 'vitest'
import { categoryStateOf, deriveClassification, deriveParts, parseBatch } from '../../../layers/sme-roster/lib/stored-file'

describe('parseBatch(照抄 pipeline/src/normalize.ts)', () => {
  it('解析「第 N 批」与年份', () => {
    expect(parseBatch('2024年度第一批')).toEqual({ year: 2024, seq: 1 })
    expect(parseBatch('2023年第二批')).toEqual({ year: 2023, seq: 2 })
  })

  it('取**第一个**四位年份 —— 正是「年份必须取目录而非文件名」的原因', () => {
    // 文号里的〔2024〕在前、正文里的 2023 在后:parseBatch 会取 2024(发布年),
    // 而这份文件的**公布年份**其实是 2023(目录说了算)。取文件名会串年份。
    expect(parseBatch('甬经信中小〔2024〕19号关于公布2023年第二批宁波市创新型中小企业名单的通知.pdf')).toEqual({
      year: 2024,
      seq: 2,
    })
  })

  it('年份区间取首年、无批次', () => {
    expect(parseBatch('2021-2022宁波市“专精特新”入库培育')).toEqual({ year: 2021, seq: null })
  })

  it('汉字批次号', () => {
    expect(parseBatch('第一批')).toEqual({ year: null, seq: 1 })
  })

  it('解析不出时对应项为 null,不硬猜', () => {
    expect(parseBatch('公布.pdf')).toEqual({ year: null, seq: null })
    expect(parseBatch('')).toEqual({ year: null, seq: null })
  })
})

describe('deriveParts 从目录反推分类', () => {
  it('年份取目录,批次取年份段后的数字段', () => {
    expect(deriveParts('jxj/announcement/2024/1/某通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 1,
    })
  })

  it('年份一律取目录、不取文件名 —— 文件名里的年份常是复核的原始认定年份', () => {
    // 2024 年发布的「2021年度第一批复核」:目录说 2024,文件名里有 2021。取目录。
    expect(deriveParts('jxj/announcement/2024/1/甬经信中小〔2024〕143号关于公布2021年度第一批…复核通过…的通知.pdf'))
      .toMatchObject({ year: 2024, batch: 1 })
  })

  it('无批次目录时批次为 null(目录给不出就留空,不硬填)', () => {
    expect(deriveParts('jxj/announcement/2022/公布.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2022,
      batch: null,
    })
  })

  it('工信部导出表无年份批次', () => {
    expect(deriveParts('miit/export/专精特新小巨人导出Excel.xlsx')).toEqual({
      source: 'miit',
      kind: 'export',
      year: null,
      batch: null,
    })
  })

  it('冲突消歧的来源子目录段不会被误当批次', () => {
    expect(deriveParts('jxj/announcement/2023/2/省专/甬经信中小〔2023〕121号…通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2023,
      batch: 2,
    })
  })

  it('认不出的路径返回 null(回填时跳过,不猜)', () => {
    expect(deriveParts('misc/random.pdf')).toBeNull()
    expect(deriveParts('README.md')).toBeNull()
  })

  it('目录**给不出**年份/批次时,才回退文件名解析(与 pipeline 同规则)', () => {
    // 正常文件库里不会有这种路径(文件库就是按年/批次分层放的)。这条只在缺目录段时兜底。
    // 注意风险:文件名里的四位数字可能是**文号**年份而非公布年份 —— 所以**目录有就绝不用文件名**(见上一条)。
    expect(deriveParts('jxj/announcement/2024年第二批的通知.pdf')).toEqual({
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 2,
    })
  })
})

describe('categoryStateOf 分类是否已定', () => {
  it('公布文件要年份才算定;没年份归 unset 交回写', () => {
    expect(categoryStateOf({ source: 'jxj', kind: 'announcement', year: 2024, batch: 1 })).toBe('set')
    expect(categoryStateOf({ source: 'jxj', kind: 'announcement', year: null, batch: null })).toBe('unset')
  })

  it('导出表只要来源类别在就算定(它本来就没有年份批次)', () => {
    expect(categoryStateOf({ source: 'miit', kind: 'export', year: null, batch: null })).toBe('set')
  })

  it('deriveClassification 合并两者', () => {
    expect(deriveClassification('miit/export/a.xlsx')).toEqual({
      source: 'miit',
      kind: 'export',
      year: null,
      batch: null,
      categoryState: 'set',
    })
  })
})
