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
  expect(document.body.textContent).toContain('提交结果尚待确认，请使用原请求重试')
  expect(document.body.textContent).not.toContain('尚未提交')
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

it('keeps formal evidence missing fields support scope and basis together while full platform fields are disclosed', async () => {
  capability()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ source: { id: 10, queryId: 1, sequenceNo: 1, nameRaw: '合成企业', usccRaw: '91330201062904769K', status: '终审通过', rawFields: { custom: '原字段正文' }, query: { id: 1, interface: 'business_list', status: 'success', rdjb: '2', relationCount: 1, collectionEvidence: null } }, correspondences: [] }))
  wrapper = mount(EventCorrespondenceDecision, { props: {
    edge,
    event: { id: 7, eventType: 'award', year: 2026, batchSeq: 1, record: { titleCode: 'specialized_sme', usccRaw: '91330201062904769K' }, evidence: [{ sourceFile: 'notice.pdf', attachment: '附件一', page: 7, listNo: 122 }] },
    candidate: { edge, conflicts: ['platform_year_missing', 'multiple_candidate_rows'] },
  } as any, attachTo: document.body, global: { stubs: { NuxtLink: true } } })
  button('确认对应').click(); await flushPromises()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('正式公布依据')
  expect(dialog.textContent).toContain('认定 2026 年')
  expect(dialog.textContent).toContain('序号 122')
  expect(dialog.textContent).toContain('平台年份缺失')
  expect(dialog.textContent).toContain('同批次流程背景')
  expect(dialog.textContent).toContain('不代表平台结论与公布一致')
  expect(dialog.textContent).toContain('核对依据（必填）')
  expect(dialog.textContent).not.toContain('原字段正文')
  expect(dialog.querySelector('textarea')).not.toBeNull()
})

it('shows a read only explanation without decision actions when capability is unavailable', async () => {
  vi.stubGlobal('useState', () => ref(false)); vi.stubGlobal('$fetch', vi.fn())
  wrapper = mountControl(); await flushPromises()
  expect(wrapper.text()).toContain('此页面当前只读')
  expect(wrapper.findAll('button')).toHaveLength(0)
})

it.each([
  ['confirm', '确认对应', null, '只确认当前这条来源的对应关系'],
  ['reject', '不对应', null, '自动处理不会重新推荐这条对应'],
  ['unlink', '取消对应', { id: 9, status: 'confirmed', revision: 2 }, '解除后不再作为有效对应出处'],
  ['correct', '改选记录', { id: 9, status: 'confirmed', revision: 2 }, '任一不满足条件，均不更换'],
])('explains %s impact without certifying platform results or other interfaces', async (_, label, existing, effect) => {
  capability()
  vi.stubGlobal('$fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/discover') ? { rows: [], page: 1, pageSize: 50, total: 0 } : existing)))
  wrapper = mountControl(existing); await flushPromises(); button(label).click(); await flushPromises()
  const explanation = document.querySelector('[aria-label="本次操作与影响"]')!
  expect(explanation.textContent).toContain(effect)
  expect(explanation.textContent).toContain('对应关系不等于平台结果通过，也不直接确定最终资格')
  expect(explanation.textContent).not.toMatch(/公布事件 #|平台原行 #/)
  expect(document.querySelectorAll('textarea')).toHaveLength(1)
  expect(document.querySelectorAll('input')).toHaveLength(0)
})

it('clears the previous event draft and preflight when switching business objects', async () => {
  capability(); const fetch = vi.fn().mockResolvedValue({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '旧事项依据'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('预检决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('预检通过，尚未提交')
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  button('确认对应').click(); await flushPromises()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
  expect(button('预检决定').disabled).toBe(true)
  expect(button('提交决定')).toBeUndefined()
})
