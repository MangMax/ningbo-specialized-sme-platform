// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonRowDetails from '../components/ComparisonRowDetails.vue'

const row = (id: number) => ({ enterpriseId: id, name: `合成企业${id}`, titleCode: 'specialized_sme', direction: 'missing_in_miit', detailUrl: `/api/comparison?view=full&enterpriseId=${id}` })
const full = (id: number) => ({ ...row(id), nameNorm: `合成企业${id}`, uscc: null, district: null, curated: false, note: `备注${id}`, evidence: {}, explanation: null,
  platform: { aliases: [], queries: [], relationCount: 0, disposition: { explanationId: null, status: 'not_queried', reasonCode: null, measureCode: null, verificationStatus: 'pending' } } })
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })
it('ignores a previous coordinate response after a newer expansion and rejects an unrelated or missing full row', async () => {
  const pending = new Map<string, (value: unknown) => void>()
  const fetch = vi.fn((url: string) => url.startsWith('/api/comparison') ? new Promise(resolve => pending.set(url, resolve)) : Promise.resolve({ titleAssessments: [] }))
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(ComparisonRowDetails, { attachTo: document.body, props: { row: row(7) as any, returnTo: '/comparison?mode=legacy&page=2' }, global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: true } } })
  await flushPromises()
  await wrapper.setProps({ row: row(8) as any })
  pending.get(row(8).detailUrl)!({ rows: [full(8)] })
  await flushPromises()
  expect(document.body.textContent).toContain('备注8')
  pending.get(row(7).detailUrl)!({ rows: [full(7)] })
  await flushPromises()
  expect(document.body.textContent).toContain('备注8')
  expect(document.body.textContent).not.toContain('备注7')
  await wrapper.setProps({ row: row(9) as any })
  expect(document.body.textContent).not.toContain('备注8')
  pending.get(row(9).detailUrl)!({ rows: [full(7)] })
  await flushPromises()
  expect(document.body.textContent).toContain('该企业、称号与方向已不在当前比对结果中')
  expect(document.body.textContent).not.toContain('备注7')
  expect(document.body.textContent).not.toContain('尚无平台查询记录')
})

it('retains successful details while a same-coordinate saved refresh fails and retries that target', async () => {
  let rejectRefresh!: (reason: Error) => void
  let detailReads = 0
  const fetch = vi.fn((url: string) => {
    if (url.startsWith('/api/comparison?')) {
      if (++detailReads === 2) return new Promise((_, reject) => { rejectRefresh = reject })
      return Promise.resolve({ rows: [{ ...full(7), note: detailReads === 1 ? '成功详情快照' : '重试后的详情' }] })
    }
    return Promise.resolve({ titleAssessments: [] })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(ComparisonRowDetails, { attachTo: document.body, props: { row: row(7) as any, returnTo: '/comparison?mode=legacy&page=2' }, global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: true } } })
  await flushPromises()
  expect(document.body.textContent).toContain('成功详情快照')
  document.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
  await flushPromises()
  expect(document.body.textContent).toContain('成功详情快照')
  rejectRefresh(Error('synthetic offline'))
  await flushPromises()
  expect(document.body.textContent).toContain('成功详情快照')
  expect(document.body.textContent).toContain('保留上次成功详情：合成企业7 · specialized_sme · missing_in_miit')
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('读取目标：合成企业7 · specialized_sme · missing_in_miit')
  Array.from(document.querySelectorAll('button')).find(button => button.textContent === '重试读取详情')!.click()
  await flushPromises()
  expect(document.body.textContent).toContain('重试后的详情')
  expect(document.body.textContent).not.toContain('成功详情快照')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await wrapper.setProps({ row: null })
  expect(document.body.textContent).not.toContain('重试后的详情')
})
