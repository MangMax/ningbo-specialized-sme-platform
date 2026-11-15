// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import Page from '../../../pages/platform-queries.vue'
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.unstubAllGlobals() })
const summary = (key: string, id = 7) => ({ total: 1, page: 1, pageSize: 50, counts: { partial: 1 }, rows: [{ relationsIncluded: false, query: { id, queryKey: key, interface: 'recognized_list', status: 'partial', rdjb: '2', queriedAt: '2026-10-21', createdAt: '2026-10-21', relationCount: 1 }, relations: [] }] })
it('starts with filtered summary only, preserves unknown fields and rejects late responses from another scope', async () => {
  const route = reactive({ query: { enterpriseId: '42', queryKey: 'old' } })
  vi.stubGlobal('useRoute', () => route)
  let old: (value: unknown) => void = () => {}
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValueOnce(summary('new', 8))
  vi.stubGlobal('$fetch', fetch)
  const w = mount(Page, { global: { stubs: { NuxtLink: { template: '<a><slot /></a>' }, PageHeader: { template: '<header><slot /></header>' } } } }); wrappers.push(w)
  expect(fetch.mock.calls[0]![1].query).toMatchObject({ view: 'summary', enterpriseId: '42', queryKey: 'old', page: 1 })
  route.query.queryKey = 'new'; await flushPromises()
  expect(w.text()).toContain('new')
  expect(w.text()).toContain('尚未加载')
  expect(w.text()).not.toContain('这条查询没有关系记录')
  old(summary('old')); await flushPromises()
  expect(w.text()).not.toContain('old')
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('retains the successful source page after a later page fails and retries only that target', async () => {
  vi.stubGlobal('useRoute', () => reactive({ query: {} }))
  const fetch = vi.fn().mockResolvedValueOnce({ ...summary('retained'), total: 51 }).mockRejectedValueOnce(new Error('page two unavailable')).mockResolvedValueOnce({ ...summary('second', 8), page: 2, total: 51 })
  vi.stubGlobal('$fetch', fetch)
  const w = mount(Page, { global: { stubs: { NuxtLink: { template: '<a><slot /></a>' }, PageHeader: { template: '<header><slot /></header>' } } } }); wrappers.push(w)
  await flushPromises()
  await w.get('[aria-label="下一页"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('保留第 1 页结果')
  expect(w.text()).toContain('retained')
  await w.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(fetch.mock.calls[2]![1].query.page).toBe(2)
  expect(w.text()).toContain('second')
  expect(w.text()).not.toContain('retained')
})
it('links a business_list query card to the local business-process page with its query key', async () => {
  vi.stubGlobal('useRoute', () => reactive({ query: {} }))
  const result = summary('91330211255994457P')
  result.rows[0]!.query.interface = 'business_list'
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(result))
  const w = mount(Page, { global: { stubs: { NuxtLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' }, PageHeader: { template: '<header><slot /></header>' } } } }); wrappers.push(w)
  await flushPromises()
  const link = w.findAll('a').find(anchor => anchor.text() === '本地办理记录')!
  expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/platform-business-processes', query: { q: '91330211255994457P' } })
})

it.each(['failed', 'not_queried', 'no_record', 'unrecognized-status'])('preserves query status %s without interpreting an unloaded relation array', async status => {
  vi.stubGlobal('useRoute', () => reactive({ query: {} }))
  const result = summary('status')
  result.rows[0]!.query.status = status
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(result))
  const w = mount(Page, { global: { stubs: { NuxtLink: { template: '<a><slot /></a>' }, PageHeader: { template: '<header><slot /></header>' } } } }); wrappers.push(w)
  await flushPromises()
  const expected: Record<string, string> = { failed: '查询失败', not_queried: '未查询', no_record: '无记录' }
  expect(w.text()).toContain(expected[status] ?? status)
  expect(w.text()).toContain('1 条关系')
  expect(w.text()).toContain('尚未加载')
})
