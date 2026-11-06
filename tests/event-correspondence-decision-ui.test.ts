// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceDecision from '../components/record-correspondence/EventCorrespondenceDecision.vue'
let wrapper: ReturnType<typeof mount>
const readbackListeners: Array<() => void> = []
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; readbackListeners.splice(0).forEach(listener => window.removeEventListener('roster-correspondence-readback', listener)); vi.unstubAllGlobals() })
const edge = { type: 'event_process', eventId: 7, relationId: 10, role: 'context_only' }
const capability = () => { vi.stubGlobal('useState', () => ref(true)) }
const mountControl = (existing: any = null) => mount(EventCorrespondenceDecision, { props: { edge, existing }, attachTo: document.body, global: { stubs: { SourceReader: true } } })
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!

async function submitPagedDecision(options: { total: number; missing?: boolean; missingId?: number; interrupt?: boolean; deferPage?: () => Promise<unknown>; ids?: number[]; invalidPage?: string; grow?: boolean }) {
  capability()
  const refreshed = vi.fn(); readbackListeners.push(refreshed); window.addEventListener('roster-correspondence-readback', refreshed)
  let key = '', interrupted = options.interrupt
  const ids = options.ids ?? [11]
  const fetch = vi.fn().mockImplementation((url: string, init?: { query?: { page?: number; pageSize?: number }; body?: any }) => {
    if (url.endsWith('browser-preflight')) {
      key = init!.body.idempotencyKey
      return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    }
    if (url.endsWith('browser-commit')) return Promise.resolve({ correspondenceIds: ids })
    if (url.endsWith('/audit')) {
      const page = init?.query?.page ?? 1, pageSize = init?.query?.pageSize ?? 50
      if (page === 2 && interrupted) { interrupted = false; return Promise.reject(new Error('offline page two')) }
      if (page === 2 && options.deferPage) return options.deferPage()
      const total = page > 1 && options.grow ? 1000 : options.total
      const missing = options.missing || url === `/api/roster/correspondences/${options.missingId}/audit`
      const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1, idempotencyKey: i === options.total - 1 && !missing ? key : `old-${i}` }))
      const audit = { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
      if (page === 2 && options.invalidPage) {
        if (options.invalidPage === 'repeated-page') audit.page = 1
        if (options.invalidPage === 'empty-page') audit.rows = []
        if (options.invalidPage === 'invalid-total') audit.total = -1
      }
      return Promise.resolve(audit)
    }
    return Promise.resolve({ id: Number(url.split('/').at(-1)), status: 'confirmed' })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const area = document.querySelector('textarea')!; area.value = '分页读回原行依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
  return { fetch, key, refreshed }
}

it.each([50, 51, 200, 201, 251])('reads the submitted key at audit row %i through the mounted decision controls', async total => {
  const { fetch, refreshed } = await submitPagedDecision({ total, ids: [11, 12] })
  expect(document.body.textContent).toContain('已提交并读回对应与审计')
  expect(button('重试读回')).toBeUndefined()
  expect(refreshed).toHaveBeenCalledTimes(1)
  for (const id of [11, 12]) {
    const audits = fetch.mock.calls.filter(([url]) => url === `/api/roster/correspondences/${id}/audit`)
    expect(audits.map(([, init]) => init?.query?.page ?? 1)).toEqual(Array.from({ length: Math.ceil(total / 50) }, (_, i) => i + 1))
  }
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
})

it('retains the receipt after an interrupted audit page and retries reads without another commit', async () => {
  const { fetch, refreshed } = await submitPagedDecision({ total: 251, interrupt: true })
  expect(document.body.textContent).toContain('决定已提交，但同步读回失败')
  expect(refreshed).not.toHaveBeenCalled()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audit')).map(([, init]) => init?.query?.page ?? 1)).toEqual([1, 2])
  button('重试读回').click(); await flushPromises()
  expect(document.body.textContent).toContain('已提交并读回对应与审计')
  expect(refreshed).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-preflight'))).toHaveLength(1)
})

it.each([0, 50, 51, 201])('never reports success when the submitted key is absent from %i audit rows', async total => {
  const { fetch, refreshed } = await submitPagedDecision({ total, missing: true })
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(button('重试读回')).toBeDefined()
  button('重试读回').click(); await flushPromises()
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
  expect(refreshed).not.toHaveBeenCalled()
})

it.each(['repeated-page', 'empty-page', 'invalid-total'])('rejects %s audit metadata without success or view refresh', async invalidPage => {
  const { fetch, refreshed } = await submitPagedDecision({ total: 51, invalidPage })
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(button('重试读回')).toBeDefined()
  expect(refreshed).not.toHaveBeenCalled()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
})

it('bounds missing key traversal to the initial audit total even while other decisions append', async () => {
  const { fetch, refreshed } = await submitPagedDecision({ total: 51, missing: true, grow: true })
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audit')).map(([, init]) => init?.query?.page ?? 1)).toEqual([1, 2])
  expect(button('重试读回')).toBeDefined()
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(refreshed).not.toHaveBeenCalled()
})

it.each([
  { name: 'empty receipt', ids: [] },
  { name: 'one receipt audit missing', ids: [11, 12], missingId: 12 },
])('keeps $name unsuccessful until every receipt ID has its own submitted audit key', async options => {
  const { fetch, refreshed } = await submitPagedDecision({ total: 51, ...options })
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(button('重试读回')).toBeDefined()
  expect(refreshed).not.toHaveBeenCalled()
  button('重试读回').click(); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
  expect(document.body.textContent).not.toContain('已提交并读回')
})

it('isolates an in flight audit page across object switches and restores only its own receipt', async () => {
  let finish!: (value: unknown) => void
  const late = new Promise(resolve => { finish = resolve })
  const { fetch, key, refreshed } = await submitPagedDecision({ total: 51, deferPage: () => late })
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audit')).map(([, init]) => init?.query?.page ?? 1)).toEqual([1, 2])
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises()
  button('确认对应').click(); await flushPromises()
  finish({ rows: [{ idempotencyKey: key }], total: 51, page: 2, pageSize: 50 }); await flushPromises()
  expect(refreshed).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(document.querySelector('textarea')!.disabled).toBe(false)
  expect(button('重试读回')).toBeUndefined()
  await wrapper.setProps({ edge }); await flushPromises(); button('确认对应').click(); await flushPromises()
  expect(button('重试读回')).toBeDefined()
  button('重试读回').click(); await flushPromises()
  expect(document.body.textContent).toContain('已提交并读回对应与审计')
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
})

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
  expect(button('提交决定').disabled).toBe(true)
  const basis = document.querySelector('textarea')!; basis.value = '核对附件一原行'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
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
  button('提交决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('没有覆盖新决定')
  button('刷新后重新核对').click(); await flushPromises()
  expect(basis.value).toBe('保留并发核对草稿')
  button('提交决定').click(); await flushPromises()
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
    if (url.endsWith('/audit')) return Promise.resolve({ rows: [{ idempotencyKey: fetch.mock.calls.find(([url]) => url.endsWith('browser-preflight'))![1].body.idempotencyKey }], total: 1, page: 1, pageSize: 50 })
    if (++reads === 1) return Promise.reject(new Error('offline'))
    return Promise.resolve({ id: 11, status: 'confirmed' })
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const basis = document.querySelector('textarea')!; basis.value = '原行确认依据'; basis.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
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
  button('提交决定').click(); await flushPromises()
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
    candidate: { edge, conflicts: ['platform_year_missing', 'multiple_candidate_rows'], evidence: { identity: { officialUsccRaw: '91330201062904769K', rowUsccRaw: '91330201062904769K' }, title: { official: 'specialized_sme', row: 'specialized_sme' }, temporal: { eventYear: 2026, relationYear: null, eventBatchSeq: 1, relationBatch: null }, process: { eventType: 'award', declareKind: 'apply' }, source: { interface: 'business_list' } } },
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
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  button('确认对应').click(); await flushPromises()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
  expect(button('提交决定').disabled).toBe(true)
})

it('blocks submission after clearing the basis and never commits the previous nonempty draft', async () => {
  capability()
  const fetch = vi.fn().mockResolvedValue({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const area = document.querySelector('textarea')!
  area.value = '预检依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  expect(button('提交决定').disabled).toBe(false)
  area.value = ''; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  expect(button('提交决定').disabled).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(0)
})

it('isolates unknown requests across event switches and restores each original frozen key without mixing drafts', async () => {
  capability()
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    if (url.endsWith('browser-commit')) return Promise.reject({ statusCode: 503 })
    throw new Error(url)
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const enter = async (text: string) => { const area = document.querySelector('textarea')!; area.value = text; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises() }
  await enter('A冻结依据'); button('提交决定').click(); await flushPromises()
  const first = fetch.mock.calls.find(([url]) => url.endsWith('browser-commit'))![1].body
  button('保留草稿并关闭').click(); await flushPromises(); button('不对应').click(); await flushPromises()
  expect(document.querySelector('textarea')!.disabled).toBe(true)
  button('重试提交').click(); await flushPromises()
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises()
  button('确认对应').click(); await flushPromises()
  expect(document.querySelector('textarea')!.disabled).toBe(false)
  expect(document.querySelector('textarea')!.value).toBe('')
  await enter('B独立依据'); button('提交决定').click(); await flushPromises()
  const requests = fetch.mock.calls.filter(([url]) => url.endsWith('browser-preflight')).map(([, options]) => options.body)
  expect(requests[1].operations[0].edge.eventId).toBe(8)
  expect(requests[1].basis).toBe('B独立依据')
  expect(requests[1].idempotencyKey).not.toBe(first.request.idempotencyKey)
  await wrapper.setProps({ edge }); await flushPromises(); button('确认对应').click(); await flushPromises()
  expect(document.querySelector('textarea')!.value).toBe('A冻结依据')
  expect(document.querySelector('textarea')!.disabled).toBe(true)
  button('重试提交').click(); await flushPromises()
  expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('browser-commit') && options.body.request.operations[0].edge.eventId === 7).map(([, options]) => options.body)).toEqual([first, first, first])
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises(); button('确认对应').click(); await flushPromises()
  expect(document.querySelector('textarea')!.value).toBe('B独立依据')
  expect(button('重试提交')).toBeDefined()
})

it('explains an empty eligible replacement page without offering protected or current records', async () => {
  capability()
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/discover') ? { page: 1, pageSize: 50, total: 2, rows: [
    { edge, existingStatus: 'confirmed' }, { edge: { ...edge, relationId: 11 }, existingStatus: 'rejected' },
  ] } : { id: 9, revision: 2, status: 'confirmed' })); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl({ id: 9, revision: 2, status: 'confirmed' }); await flushPromises(); button('改选记录').click(); await flushPromises()
  expect(document.body.textContent).toContain('本页无可改选记录')
  expect(document.body.textContent).toContain('保留已有人工决定')
  expect(document.querySelector('#replacement-record')!.getAttribute('disabled')).not.toBeNull()
  expect(button('提交决定').disabled).toBe(true)
  expect(document.body.textContent).toContain('共 2 条归档记录')
})

it('ignores a late commit response after switching objects and retries the original object with its bound request', async () => {
  capability()
  let finish!: (value: any) => void
  const late = new Promise(resolve => { finish = resolve })
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('browser-preflight')) return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    if (url.endsWith('browser-commit')) return late
    if (url.endsWith('/audit')) return Promise.resolve({ rows: [] })
    return Promise.resolve({ id: 11, status: 'confirmed' })
  }); vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const area = document.querySelector('textarea')!; area.value = 'A在途依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
  const first = fetch.mock.calls.find(([url]) => url.endsWith('browser-commit'))![1].body
  await wrapper.setProps({ edge: { ...edge, eventId: 8 } }); await flushPromises(); button('确认对应').click(); await flushPromises()
  finish({ correspondenceIds: [11] }); await flushPromises()
  expect(document.querySelector('textarea')!.disabled).toBe(false)
  expect(document.body.textContent).not.toContain('已提交并读回')
  expect(button('重试读回')).toBeUndefined()
  await wrapper.setProps({ edge }); await flushPromises(); button('确认对应').click(); await flushPromises()
  expect(document.querySelector('textarea')!.disabled).toBe(true)
  expect(button('重试提交')).toBeDefined()
  button('重试提交').click()
  await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit')).map(([, options]) => options.body)).toEqual([first, first])
})

it('keeps the only required basis field in the action area while preserving the evidence reader', async () => {
  capability(); vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const footer = document.querySelector('[data-testid="decision-footer"]')!
  expect(footer.querySelectorAll('textarea')).toHaveLength(1)
  expect(footer.textContent).toContain('核对依据（必填）')
  expect(document.querySelector('[aria-label="待核平台原行"]')).not.toBeNull()
  expect(wrapper.findComponent({ name: 'SourceReader' }).props('presentation')).toBe('business')
  expect(button('提交决定').disabled).toBe(true)
})

it('submits one business action through preflight and waits for public readback before reporting saved', async () => {
  capability()
  let resolvePlan!: (value: unknown) => void
  let resolveAudit!: (value: unknown) => void
  let key = ''
  const fetch = vi.fn((url: string, options?: any) => {
    if (url.endsWith('browser-preflight')) { key = options.body.idempotencyKey; return new Promise(resolve => { resolvePlan = resolve }) }
    if (url.endsWith('browser-commit')) return Promise.resolve({ correspondenceIds: [11] })
    if (url.endsWith('/audit')) return new Promise(resolve => { resolveAudit = resolve })
    return Promise.resolve({ id: 11, status: 'confirmed' })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  expect(button('预检决定')).toBeUndefined()
  const area = document.querySelector('textarea')!
  area.value = '核对两侧原始依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
  expect(button('正在保存…').disabled).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(0)
  resolvePlan({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } }); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
  expect(document.body.textContent).not.toContain('已保存平台对应决定')
  resolveAudit({ rows: [{ idempotencyKey: key }], total: 1, page: 1, pageSize: 50 }); await flushPromises()
  expect(document.body.textContent).toContain('已保存平台对应决定')
  expect(document.body.textContent).toContain('年度最终结果与来源变化处理仍需分别核对')
})

it.each([409, 503])('keeps the basis after preflight failure %i and commits only after a successful retry', async statusCode => {
  capability()
  let attempts = 0, key = ''
  const fetch = vi.fn((url: string, options?: any) => {
    if (url.endsWith('browser-preflight')) {
      if (++attempts === 1) return Promise.reject({ statusCode })
      key = options.body.idempotencyKey
      return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 2 } })
    }
    if (url.endsWith('browser-commit')) return Promise.resolve({ correspondenceIds: [11] })
    if (url.endsWith('/audit')) return Promise.resolve({ rows: [{ idempotencyKey: key }], total: 1, page: 1, pageSize: 50 })
    return Promise.resolve({ id: 11, status: 'confirmed' })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl(); await flushPromises(); button('确认对应').click(); await flushPromises()
  const area = document.querySelector('textarea')!; area.value = '失败后保留核对依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(0)
  expect(document.body.textContent).not.toContain('已保存平台对应决定')
  expect(area.value).toBe('失败后保留核对依据'); expect(area.disabled).toBe(false)
  if (statusCode === 409) { button('刷新后重新核对').click(); await flushPromises() }
  button('提交决定').click(); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(1)
  expect(document.body.textContent).toContain('已保存平台对应决定')
})

it('explains a stale candidate contract block without offering the impossible refresh-submit loop', async () => {
  capability()
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('browser-preflight')) throw { statusCode: 409, data: { error: { code: 'plan_mismatch', message: 'Source row changed since correspondence decision' } } }
    return { id: 4, revision: 1, status: 'candidate' }
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountControl({ id: 4, revision: 1, status: 'candidate' }); await flushPromises()
  button('不对应').click(); await flushPromises()
  const area = document.querySelector('textarea')!; area.value = '保留原候选的判断依据'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  button('提交决定').click(); await flushPromises()
  expect(document.body.textContent).toContain('候选来源已变化，当前服务暂不支持更新此候选的来源依据')
  expect(button('刷新后重新核对')).toBeUndefined()
  expect(button('提交决定')).toBeUndefined()
  expect(area.value).toBe('保留原候选的判断依据')
  area.value += '补充'; area.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  expect(button('提交决定')).toBeUndefined()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('browser-commit'))).toHaveLength(0)
})
