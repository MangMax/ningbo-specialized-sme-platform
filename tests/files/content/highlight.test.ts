import { expect, it } from 'vitest'
import { highlightContent } from '../../../lib/content-highlight'
it('highlights real code and Markdown with local grammars across themes and escapes HTML', async () => {
  const light = await highlightContent('const 企业 = "<script>"', 'js', 'light')
  expect(light).toContain('shiki github-light')
  expect(light).toContain('&#x3C;script>')
  expect(light).not.toContain('<script>')
  expect(light).toContain('<span style=')
  expect(await highlightContent('print("甲")', 'py', 'dark')).toContain('shiki github-dark')
  expect(await highlightContent('# 标题', 'markdown', 'light')).toContain('<span style=')
  expect(await highlightContent('abc', 'unknown', 'light')).toBeNull()
  expect(await highlightContent('a'.repeat(100001), 'js', 'light')).toBeNull()
})

it.each([
  ['jsonl', '{"企业":"甲"}\n{"企业":"乙"}'],
  ['typescript', 'const year: number = 2026'],
  ['yaml', '企业: 宁波甲'],
  ['sql', 'SELECT name FROM enterprise;'],
  ['jsx', 'const view = <div>甲</div>'],
  ['tsx', 'const view: JSX.Element = <div>乙</div>'],
  ['html', '<table><tr><td>甲</td></tr></table>'],
  ['css', 'table { color: red; }'],
])('highlights supported %s content using the published local grammar', async (language, source) => {
  expect(await highlightContent(source, language, 'light')).toContain('<span style=')
})
