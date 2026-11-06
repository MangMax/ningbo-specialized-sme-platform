// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonEventRow from '../components/record-correspondence/ComparisonEventRow.vue'
import type { RecordComparisonResult } from '../lib/roster/record-comparison-view'
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals() })
const row = (sourceFile: string, page: number | null) => ({
  event: { id: 8, eventType: 'award', year: null },
  record: { enterpriseId: 4, titleCode: 'specialized_sme', nameRaw: '合成企业' },
  evidence: [{ id: 2, sourceFile, attachment: '附件二 / 名单三', listNo: 1, page, inSelectedSource: true }],
  reasons: [], classification: 'unresolved', platformRows: [], correspondences: [],
}) as unknown as RecordComparisonResult['rows'][number]
const render = (sourceFile: string, page: number | null) => {
  const wrapper = mount(ComparisonEventRow, { props: { row: row(sourceFile, page), returnTo: '/comparison?mode=record' }, global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' } } } })
  wrappers.push(wrapper); return wrapper
}
it('keeps exact source coordinates and distinguishes unavailable files from pending PDF pages and non PDF sources', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  const missing = render('jxj/missing.pdf', 3)
  await flushPromises()
  expect(missing.text()).toContain('文件不可用')
  expect(missing.text()).toContain('jxj/missing.pdf')
  expect(missing.text()).toContain('附件二 / 名单三')
  expect(missing.text()).toContain('序号 1')
  expect(missing.findAll('a').some(link => link.text() === '第 3 页')).toBe(false)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
  const pending = render('jxj/pending.pdf', null)
  const word = render('jxj/source.docx', 9)
  const assigned = render('jxj/source.pdf', 8)
  await flushPromises()
  expect(pending.text()).toContain('页码待核')
  expect(pending.findAll('a').some(link => /第 .* 页/.test(link.text()))).toBe(false)
  expect(word.text()).toContain('这类文件没有可复核的页码')
  expect(word.findAll('a').some(link => /第 .* 页/.test(link.text()))).toBe(false)
  const jump = assigned.findAll('a').find(link => link.text() === '第 8 页')!
  expect(jump.attributes('href')).toContain('page=8')
  expect(decodeURIComponent(jump.attributes('href')!)).toContain('file=jxj/source.pdf')
})

it('recovers an unknown file check through explicit retry without remounting the source', async () => {
  const head = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, status: 200 })
  vi.stubGlobal('fetch', head)
  const view = render('jxj/retry.pdf', 3)
  await flushPromises()
  expect(view.text()).toContain('暂无法确认文件是否可用')
  const retry = view.findAll('button').find(button => button.text() === '重新检查文件')
  expect(retry).toBeDefined()
  await retry!.trigger('click'); await flushPromises()
  expect(head).toHaveBeenCalledTimes(2)
  expect(view.findAll('a').find(link => link.text() === '第 3 页')?.attributes('href')).toContain('page=3')
})
