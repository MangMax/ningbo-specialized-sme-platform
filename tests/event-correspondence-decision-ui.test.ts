// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceDecision from '../components/record-correspondence/EventCorrespondenceDecision.vue'
let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const edge = { type: 'event_process', eventId: 7, relationId: 10, role: 'context_only' }
const capability = () => { vi.stubGlobal('useState', () => ref(true)) }
const mountControl = (existing: any = null) => mount(EventCorrespondenceDecision, { props: { edge, existing }, attachTo: document.body, global: { stubs: { SourceReader: true } } })
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!

it('requires basis and retains the bound draft after commit failure then retries the same receipt key', async () => {
  capability()
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    if (url.endsWith('browser-commit')) return Promise.reject({ statusCode: 503 })
    return Promise.resolve({ rows: [] })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises()
  button('确认对应').click(); await flushPromises()
  expect(button('预检决定').disabled).toBe(true)
  const basis = document.querySelector('textarea')!; basis.value = '核对附件一原行'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('预检决定').click(); await flushPromises()
  button('提交决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('草稿和预检保留')
  expect(basis.value).toBe('核对附件一原行')
  button('重试提交').click(); await flushPromises()
  const writes = fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))
  expect(writes).toHaveLength(2)
  expect(writes[1]![1].body).toEqual(writes[0]![1].body)
  expect(document.body.textContent).not.toContain('已提交并读回')
})

it('shows state appropriate actions and retains historical revalidation instead of certifying it', async () => {
  capability(); vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ status: 'confirmed', revision: 2, requiresRevalidation: true }))
  wrapper = mountControl({ id: 9, revision: 2, status: 'confirmed', requiresRevalidation: true }); await flushPromises()
  expect(button('取消对应')).toBeTruthy(); expect(button('改选记录')).toBeTruthy(); expect(button('确认对应')).toBeUndefined(); expect(button('不对应')).toBeUndefined()
  button('重新核验对应').click(); await flushPromises()
  expect(document.body.textContent).toContain('历史确认暂不算有效出处')
  await wrapper.setProps({ existing: { id: 9, revision: 3, status: 'rejected' } })
  expect(wrapper.text()).toContain('保留历史决定')
  expect(wrapper.findAll('button').filter(b => ['确认对应', '不对应', '取消对应', '改选记录'].includes(b.text()))).toHaveLength(0)
})

it('keeps a stale draft and requires a fresh preflight after refreshing the current revision', async () => {
  capability()
  let revision = 2
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/9')) return Promise.resolve({ id: 9, status: 'confirmed', revision })
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: String(revision).repeat(64), impact: { created: 0, unlinked: 1, audit: 1 } })
    if (url.endsWith('browser-commit')) { revision = 4; return Promise.reject({ statusCode: 409 }) }
    throw new Error(url)
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl({ id: 9, revision: 2, status: 'confirmed' }); await flushPromises()
  button('取消对应').click(); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '保留并发核对草稿'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('预检决定').click(); await flushPromises(); button('提交决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('没有覆盖新决定')
  button('刷新后重新核对').click(); await flushPromises()
  expect(basis.value).toBe('保留并发核对草稿')
  button('预检决定').click(); await flushPromises()
  const requests = fetch.mock.calls.filter(([url]) => url.endsWith('browser-preflight')).map(([, options]) => options.body)
  expect(requests[0].operations[0].expectedRevision).toBe(2)
  expect(requests[1].operations[0].expectedRevision).toBe(4)
  expect(requests[1].idempotencyKey).not.toBe(requests[0].idempotencyKey)
})

it('retains a committed receipt when readback fails and retries only the public reads', async () => {
  capability(); let reads = 0
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    if (url.endsWith('browser-commit')) return Promise.resolve({ correspondenceIds: [11] })
    if (url.endsWith('/audit')) return Promise.resolve({ rows: [{ idempotencyKey: fetch.mock.calls.find(([url]) => url.endsWith('browser-preflight'))![1].body.idempotencyKey }] })
    if (++reads === 1) return Promise.reject(new Error('offline'))
    return Promise.resolve({ id: 11, status: 'confirmed' })
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '原行确认依据'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('预检决定').click(); await flushPromises(); button('提交决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('决定已提交，但同步读回失败')
  button('重试读回').click(); await flushPromises()
  expect(document.body.textContent).toContain('已提交并读回对应与审计')
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
})

it('keeps the open decision draft when discovery refreshes the same event and relation', async () => {
  capability(); vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '同一原行刷新仍保留'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  await wrapper.setProps({ edge: { ...edge } }); await flushPromises()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('同一原行刷新仍保留')
})

it('corrects to the registered candidate role rather than replacing its historical role with a discovery default', async () => {
  capability()
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/9')) return Promise.resolve({ id: 9, revision: 2, status: 'confirmed' })
    if (url.endsWith('/77')) return Promise.resolve({ id: 77, revision: 1, status: 'candidate', type: 'event_process', eventId: 7, relationId: 11, role: 'supports_award' })
    if (url.endsWith('/discover')) return Promise.resolve({ page: 1, pageSize: 50, total: 1, rows: [{ edge: { ...edge, relationId: 11 }, existingCorrespondenceId: 77, existingStatus: 'candidate', evidence: { source: { queryId: 2, sequenceNo: 1 } } }] })
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: 'b'.repeat(64), impact: { created: 0, unlinked: 1, audit: 2 } })
    throw new Error(url)
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl({ id: 9, revision: 2, status: 'confirmed' }); await flushPromises()
  button('改选记录').click(); await flushPromises()
  ;(document.querySelector('[role="dialog"] [role="combobox"]') as HTMLButtonElement).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })); await flushPromises()
  ;(document.querySelector('[role="option"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '已核对B原有支持角色'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('预检决定').click(); await flushPromises()
  const submitted = fetch.mock.calls.find(([url]) => url.endsWith('browser-preflight'))![1].body
  expect(submitted.operations).toEqual([{ action: 'correct', correspondenceId: 9, expectedRevision: 2, edge: { type: 'event_process', eventId: 7, relationId: 11, role: 'supports_award' } }])
})
