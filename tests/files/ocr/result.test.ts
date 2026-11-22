import { describe, expect, it } from 'vitest'
import {
  assembleMarkdown, formatPage, MAX_PAGE_NO, normalizeMarkdownBody,
  pageMarker, pageNoOfMarker, PAGE_MARKER_RE, splitMarkdown,
} from '../../../layers/core/lib/ocr-markdown'
import { pagesFromInput } from '../../../layers/core/server/utils/ocr-result-contract'

describe('lib/ocr-markdown 页标记', () => {
  it('规范标记是 HTML 注释 —— 渲染时不可见、不占标题层级', () => {
    expect(pageMarker(3)).toBe('<!-- page: 3 -->')
    expect(PAGE_MARKER_RE.test('<!-- page: 3 -->')).toBe(true)
    expect(PAGE_MARKER_RE.test('<!--page:3-->')).toBe(true) // 空格可有可无
    expect(PAGE_MARKER_RE.test('正文里提到 <!-- page: 3 --> 一句')).toBe(false) // 必须整行
  })

  it('两种形态都认:规范注释 + 外部工具常见的 `## 第 3 页` 标题', () => {
    expect(pageNoOfMarker('<!-- page: 1 -->')).toBe(1)
    expect(pageNoOfMarker('## 第 3 页')).toBe(3)
    expect(pageNoOfMarker('### 第12页')).toBe(12)
    // 正文标题里带了别的话就不算标记(否则「第 3 页附表」会被当成分隔符切下去)。
    expect(pageNoOfMarker('## 第 3 页附表')).toBeNull()
    expect(pageNoOfMarker('正文')).toBeNull()
    expect(pageNoOfMarker('<!-- page: 0 -->')).toBeNull() // 页号从 1 起
    expect(pageNoOfMarker(`<!-- page: ${MAX_PAGE_NO + 1} -->`)).toBeNull()
  })

  it('splitMarkdown:按标记切页,页内表格与空行原样保留', () => {
    const md = [
      '<!-- page: 1 -->',
      '',
      '### 附件1',
      '',
      '| 序号 | 企业名称 |',
      '| --- | --- |',
      '| 1 | 宁波甲科技有限公司 |',
      '',
      '<!-- page: 2 -->',
      '',
      '### 附件2',
      '',
      '| 序号 | 企业名称 |',
      '| --- | --- |',
      '| 1 | 宁波乙科技有限公司 |',
    ].join('\n')

    const out = splitMarkdown(md)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages.map((p) => p.page)).toEqual([1, 2])
    expect(out.pages[0]!.markdown).toContain('### 附件1')
    expect(out.pages[0]!.markdown).toContain('| 1 | 宁波甲科技有限公司 |')
    expect(out.pages[1]!.markdown).toContain('| 1 | 宁波乙科技有限公司 |')
    // 标记行本身不进正文。
    expect(out.pages[0]!.markdown).not.toContain('<!-- page')
  })

  it('★ 页码乱序**报错**,不自动重排(重排会替调用方猜页序,而页序错了页码就全错)', () => {
    // 这份输入:第 2 页的标记写在第 1 页之前。若「排一下就好」,甲会被标成第 1 页
    // —— 而甲明明是第 2 页。下游按页号升序摊平块,于是页码静默错位。
    const out = splitMarkdown('<!-- page: 2 -->\n\n乙\n\n<!-- page: 1 -->\n\n甲')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.message).toContain('乱序')
      expect(out.message).toContain('不自动重排')
    }
  })

  it('splitMarkdown:标题式的页码也认,且归一成同一份结果', () => {
    const withHeading = ['## 第 1 页', '', '甲', '', '## 第 2 页', '', '乙'].join('\n')
    const out = splitMarkdown(withHeading)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages).toEqual([
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '乙' },
    ])
  })

  it('空页**保留**(空白页也占一个页号 —— 少了它页号就断)', () => {
    const out = splitMarkdown(['<!-- page: 1 -->', '甲', '<!-- page: 2 -->', '', '<!-- page: 3 -->', '丙'].join('\n'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages).toEqual([
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '' },
      { page: 3, markdown: '丙' },
    ])
  })

  it('三种「页号说不清」都**报错**,不猜', () => {
    // 一个标记都没有:整份当成第 1 页存下来是最坏的结果(20 页的文档会变成一个页号)。
    const none = splitMarkdown('### 附件1\n\n| 1 | 甲 |')
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toContain('没有页码标记')

    // 首个标记之前有正文:那段属于哪一页无从判断。
    const preamble = splitMarkdown('这是标题\n\n<!-- page: 1 -->\n甲')
    expect(preamble.ok).toBe(false)
    if (!preamble.ok) expect(preamble.message).toContain('之前')

    // 页号重复:唯一索引会抛底层错误,这里先说人话。
    const dup = splitMarkdown('<!-- page: 1 -->\n甲\n\n<!-- page: 1 -->\n乙')
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('页码重复')
  })

  it('归一:去掉行尾空白与首尾空行,但**不动行内对齐空格**', () => {
    expect(normalizeMarkdownBody('\n\n| a |   b   |   \n\n')).toBe('| a |   b   |')
    expect(normalizeMarkdownBody('a\r\nb')).toBe('a\nb')
  })

  it('★ 导出再传回来,逐字节相同(通路 b 的闭环前提)', () => {
    const pages = [
      { page: 1, markdown: '### 附件1\n\n| 序号 | 企业名称 |\n| --- | --- |\n| 1 | 宁波甲科技有限公司 |' },
      { page: 2, markdown: '' },
      { page: 3, markdown: '### 附件2\n\n正文三' },
    ]
    const exported = assembleMarkdown(pages)
    expect(exported.startsWith('<!-- page: 1 -->')).toBe(true)
    const back = splitMarkdown(exported)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.pages).toEqual(pages)
    // 再拼一次也完全一致(幂等的文本形态)。
    expect(assembleMarkdown(back.pages)).toBe(exported)
    expect(formatPage(pages[0]!)).toBe(`<!-- page: 1 -->\n\n${pages[0]!.markdown}`)
  })
})

describe("OCR markdown import", () => {
  it('单页输入(没有页标记)必须显式给 page —— 给了就写那一页', () => {
    const noPage = pagesFromInput('只有正文,没有页标记', null)
    expect(noPage.ok).toBe(false)
    if (!noPage.ok) expect(noPage.message).toContain('page')
    const withPage = pagesFromInput('只有正文,没有页标记', 3)
    expect(withPage.ok).toBe(true)
    if (!withPage.ok) return
    expect(withPage.pages).toEqual([{ page: 3, markdown: '只有正文,没有页标记' }])
    expect(pagesFromInput('x', 0).ok).toBe(false)
  })

  it('★ 给了 page 就**不许**正文再带页标记(否则导出文件传不回自己的上传口)', () => {
    // 照单全收的后果:标记被当正文存进那一页 → 导出后嵌着别的页的标记 →
    // 再 POST /api/ocr-results 会得到「页码重复」。
    const both = pagesFromInput('<!-- page: 1 -->\n\n甲\n\n<!-- page: 2 -->\n\n乙', 3)
    expect(both.ok).toBe(false)
    if (!both.ok) expect(both.message).toContain('不该再带页标记')
    // `## 第 N 页` 这种形态同样不许。
    expect(pagesFromInput('## 第 1 页\n\n甲', 3).ok).toBe(false)
    // 正文里**行内**提到「第 3 页」不算标记(必须是整行的标题)。
    expect(pagesFromInput('详见第 3 页的说明', 3).ok).toBe(true)
  })
})
