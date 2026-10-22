// @vitest-environment happy-dom
// Component/composable seam only: these are not actual Nuxt/browser evidence.
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useLogRead } from '../composables/useLogRead'
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
it('keeps the previous source on failed navigation and ignores a late superseded read', async () => {
  const key = ref('first'),
    first = deferred<{ label: string }>(),
    late = deferred<{ label: string }>(),
    failed = deferred<{ label: string }>()
  let read!: ReturnType<typeof useLogRead<{ label: string }>>
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          read = useLogRead(key, (target) => ({ first, late, failed })[target as 'first'].promise)
          return () => h('p', read.data.value?.label)
        }
      })
    )
  )
  first.resolve({ label: 'original' })
  await flushPromises()
  key.value = 'late'
  await flushPromises()
  key.value = 'failed'
  await flushPromises()
  failed.reject({ data: { error: { code: 'logging_unavailable' } } })
  await flushPromises()
  expect(read.data.value).toEqual({ label: 'original' })
  expect(read.sourceKey.value).toBe('first')
  expect(read.error.value).toBe('logging_unavailable')
  late.resolve({ label: 'wrong' })
  await flushPromises()
  expect(read.data.value).toEqual({ label: 'original' })
  expect(read.error.value).toBe('logging_unavailable')
})

it('requires review before policy writes, keeps the requested shrink after 409, and never claims it active', async () => {
  const { default: Management } = await import('../components/logs/LogManagement.vue')
  let writes = 0
  vi.stubGlobal('$fetch', async (_url: string, options?: { method?: string }) => {
    if (options?.method === 'PATCH') {
      writes++
      throw { data: { error: { code: 'policy_capacity_pending' } } }
    }
    return {
      retentionDays: 7,
      maxBytes: 536870912,
      storageBytes: 4096,
      pruned: 0,
      cleared: 0,
      accounting: 'main+sidecars',
      status: { dropped: 0, unavailable: false }
    }
  })
  const wrapper = mount(Management, { props: { filter: {} }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('#log-max-bytes').setValue('1048576')
  await wrapper.get('form').trigger('submit')
  expect(writes).toBe(0)
  await flushPromises()
  const confirm = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('确认修改策略')
  )!
  expect(confirm).toBeTruthy()
  confirm.click()
  await flushPromises()
  expect(writes).toBe(1)
  expect(wrapper.text()).toContain('原策略仍生效')
  expect((wrapper.get('#log-max-bytes').element as HTMLInputElement).value).toBe('1048576')
  expect(wrapper.text()).toContain('536870912')
  vi.unstubAllGlobals()
})

it('filters by known IDs, pages with server cursors, fetches details on demand and copies only the safe event', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const calls: { url: string; options: any }[] = []
  const event = {
    id: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-10-22T00:00:00Z',
    source: 'task',
    operation: 'task.finished',
    outcome: 'success',
    level: 'info',
    taskId: 'task-182',
    errorCode: 'safe_code',
    authorization: 'private-nonce'
  }
  vi.stubGlobal('$fetch', async (url: string, options: any) => {
    calls.push({ url, options })
    if (url === '/api/logs/policy')
      return {
        retentionDays: 7,
        maxBytes: 536870912,
        storageBytes: 4096,
        pruned: 0,
        cleared: 0,
        status: {}
      }
    if (url.startsWith('/api/logs/')) return event
    return { rows: [event], nextCursor: options.query.cursor ? null : '26', status: { dropped: 0 } }
  })
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/logs', component: Page },
      { path: '/tasks', component: { render: () => null } }
    ]
  })
  await router.push('/logs?taskId=task-182')
  await router.isReady()
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  expect(calls.find((c) => c.url === '/api/logs')!.options.query.taskId).toBe('task-182')
  expect(calls.some((c) => c.url.endsWith(event.id))).toBe(false)
  await wrapper.get('[data-table-next]').trigger('click')
  await flushPromises()
  expect(calls.filter((c) => c.url === '/api/logs').at(-1)!.options.query.cursor).toBe('26')
  const beforeRefresh = calls.filter((c) => c.url === '/api/logs').length
  const latest = wrapper.findAll('button').find((b) => b.text() === '刷新最新日志')!
  await latest.trigger('click')
  await flushPromises()
  expect(calls.filter((c) => c.url === '/api/logs').length - beforeRefresh).toBe(1)
  await wrapper.get('[data-log-detail]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('safe_code')
  const button = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('复制脱敏事件')
  )!
  button.click()
  await flushPromises()
  expect(copy).toHaveBeenCalledOnce()
  expect(copy.mock.calls[0]![0]).toContain('task-182')
  expect(copy.mock.calls[0]![0]).not.toContain('private-nonce')
  expect(
    calls.every(
      (c) => c.options.headers['x-log-browser'] === '1' && !c.options.headers.authorization
    )
  ).toBe(true)
  vi.unstubAllGlobals()
})

it('requires an explicit chronological range and freezes all applied filters before one bounded clear', async () => {
  const { default: Management } = await import('../components/logs/LogManagement.vue')
  const posts: any[] = []
  const clear = deferred<{ deleted: number; hasMore: boolean }>()
  vi.stubGlobal('$fetch', async (_url: string, options?: any) => {
    if (options?.method === 'POST') {
      posts.push(options.body)
      return clear.promise
    }
    return {
      retentionDays: 7,
      maxBytes: 536870912,
      storageBytes: 4096,
      pruned: 0,
      cleared: 0,
      status: {}
    }
  })
  const wrapper = mount(Management, { props: { filter: {} }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  const button = wrapper.findAll('button').find((b) => b.text() === '清理当前筛选范围')!
  expect((button.element as HTMLButtonElement).disabled).toBe(true)
  await wrapper.setProps({
    filter: {
      from: '2026-10-22T10:00:00+08:00',
      to: '2026-10-22T03:00:00Z',
      taskId: 'task-182',
      limit: 25,
      cursor: '55'
    }
  })
  expect((button.element as HTMLButtonElement).disabled).toBe(false)
  await button.trigger('click')
  await flushPromises()
  expect(posts).toHaveLength(0)
  expect(document.querySelector('[role=dialog]')!.textContent).toContain('task-182')
  await wrapper.setProps({
    filter: { from: '2026-10-21T00:00:00Z', to: '2026-10-21T01:00:00Z', taskId: 'other-task' }
  })
  const confirm = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === '确认清理范围'
  )!
  confirm.click()
  confirm.click()
  await flushPromises()
  expect(posts).toEqual([
    {
      from: '2026-10-22T10:00:00+08:00',
      to: '2026-10-22T03:00:00Z',
      taskId: 'task-182',
      confirm: true
    }
  ])
  clear.resolve({ deleted: 1000, hasMore: true })
  await flushPromises()
  expect(wrapper.text()).toContain('本次已清理 1000 条')
  expect(wrapper.text()).toContain('范围内仍有日志')
  expect(wrapper.text()).toContain('task-182')
  expect(posts).toHaveLength(1)
  vi.unstubAllGlobals()
})

it('retains source rows on a failed filter, explains both targets, retries explicitly and recovers to empty', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const response = deferred<any>()
  let attempts = 0
  vi.stubGlobal('$fetch', async (_url: string, options: any) => {
    if (options.query.requestId) {
      attempts++
      if (attempts === 1)
        throw { data: { error: { code: 'invalid_log_input' }, message: 'PRIVATE182_RAW_ERROR' } }
      return response.promise
    }
    return {
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          timestamp: '2026-10-22T00:00:00Z',
          source: 'http',
          operation: 'http.request',
          outcome: 'success',
          level: 'info',
          requestId: 'req-original'
        }
      ],
      nextCursor: null,
      status: { dropped: 0 }
    }
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/logs', component: Page }]
  })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  await router.push('/logs?requestId=req-new')
  await flushPromises()
  const failure = wrapper.get('[data-testid=table-failure-state]').text()
  expect(failure).toContain('req-new')
  expect(failure).toContain('已保留第 1 页的 1 条旧结果')
  expect(failure).toContain('请求标识 req-new')
  expect(failure).not.toContain('{"')
  expect(failure).not.toContain('筛选 {}')
  expect(wrapper.text()).toContain('req-original')
  expect(wrapper.text()).not.toContain('PRIVATE182_RAW_ERROR')
  await wrapper.get('[data-testid=table-retry]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('正在读取运行日志')
  expect(wrapper.text()).toContain('req-original')
  response.resolve({ rows: [], nextCursor: null, status: { dropped: 0 } })
  await flushPromises()
  expect(wrapper.text()).toContain('没有符合条件的运行日志')
  expect(wrapper.text()).not.toContain('req-original')
  expect(attempts).toBe(2)
})

it('composes filter and policy controls in shared fields while preserving every linked label', async () => {
  const { default: Filters } = await import('../components/logs/LogFilters.vue')
  const wrapper = mount(Filters, { props: { filter: { requestId: 'req-180' } }, attachTo: document.body })
  wrappers.push(wrapper)
  expect(wrapper.findAll('[data-slot="field-group"]')).toHaveLength(2)
  expect(wrapper.findAll('[data-slot="field"]')).toHaveLength(12)
  for (const label of wrapper.findAll('label[for]')) {
    expect(document.getElementById(label.attributes('for')!)).not.toBeNull()
    expect(label.element.closest('[data-slot="field"]')).not.toBeNull()
  }
})

it('shows and copies only a validated UNTRUSTED client request reference, distinct from intake IDs', async () => {
  const { default: Detail } = await import('../components/logs/LogDetail.vue')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const event = { id: '00000000-0000-4000-8000-000000000180', source: 'client', operation: 'client.tasks.interaction_failure', requestId: 'intake-180', traceId: 'intake-trace', untrustedRelatedRequestId: 'original-180' }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } }); wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('关联请求（客户端声称，UNTRUSTED）')
  expect(wrapper.text()).toContain('original-180')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ requestId: 'intake-180', traceId: 'intake-trace', untrustedRelatedRequestId: 'original-180' })
  event.untrustedRelatedRequestId = '<script>PRIVATE180</script>'
  await wrapper.setProps({ id: '00000000-0000-4000-8000-000000000181' })
  event.id = '00000000-0000-4000-8000-000000000181'
  await flushPromises()
  expect(wrapper.text()).not.toContain('PRIVATE180')
})

const policyView = {
  retentionDays: 7,
  maxBytes: 536870912,
  storageBytes: 4096,
  pruned: 0,
  cleared: 0,
  status: { dropped: 0, unavailable: false, since: '2026-10-22T00:00:00.000Z' }
}
const listRow = (id: string) => ({
  id,
  timestamp: '2026-10-22T00:00:00Z',
  source: 'http',
  operation: 'http.request',
  outcome: 'success',
  level: 'info',
  requestId: `req-${id.slice(-1)}`
})

it('holds the result area with skeleton rows and a reading footer during the first read', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const pending = deferred<any>()
  vi.stubGlobal('$fetch', async (url: string) => (url === '/api/logs/policy' ? policyView : pending.promise))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  // 首次读取：按每页条数铺骨架（桌面行 / 窄屏卡），分页占位，而不是把卡收成一条表头。
  expect(wrapper.findAll('[data-testid=log-row-skeleton]')).toHaveLength(25)
  expect(wrapper.findAll('[data-testid=log-card-skeleton]')).toHaveLength(25)
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('正在读取…')
  pending.resolve({ rows: [listRow('00000000-0000-4000-8000-000000000001')], nextCursor: null, status: { dropped: 0 } })
  await flushPromises()
  expect(wrapper.findAll('[data-testid=log-row-skeleton]')).toHaveLength(0)
  expect(wrapper.findAll('[data-testid=log-card-skeleton]')).toHaveLength(0)
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('本页 1 条 · 第 1 页')
})

it('returns the result list to its first row after a page change and keeps filter and page size', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const calls: { url: string; options: any }[] = []
  vi.stubGlobal('$fetch', async (url: string, options: any) => {
    if (url === '/api/logs/policy') return policyView
    calls.push({ url, options })
    return {
      rows: [listRow('00000000-0000-4000-8000-000000000002')],
      nextCursor: options.query.cursor ? null : '26',
      status: { dropped: 0 }
    }
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  const scroller = wrapper.get('[data-testid=log-table-scroll]').element as HTMLElement
  scroller.scrollTop = 120
  await wrapper.get('[data-table-next]').trigger('click')
  await flushPromises()
  await flushPromises()
  expect(calls.at(-1)!.options.query).toMatchObject({ cursor: '26', limit: 25 })
  expect(scroller.scrollTop).toBe(0)
  expect(document.activeElement?.id).toBe('log-list-heading')
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('本页 1 条 · 第 2 页')
  expect(wrapper.get('.data-table thead').text()).toContain('操作 / 来源')
  expect(wrapper.text()).not.toContain('共 0')
})

it('does not offer a policy review until a value actually differs from the active policy', async () => {
  const { default: Management } = await import('../components/logs/LogManagement.vue')
  vi.stubGlobal('$fetch', async () => policyView)
  const wrapper = mount(Management, { props: { filter: {} }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  const review = wrapper.findAll('button').find((b) => b.text() === '核对策略修改')!
  expect((review.element as HTMLButtonElement).disabled).toBe(true)
  expect(wrapper.text()).toContain('当前值与已生效策略相同')
  await wrapper.get('#log-retention-days').setValue('8')
  expect((review.element as HTMLButtonElement).disabled).toBe(false)
  expect(wrapper.text()).not.toContain('当前值与已生效策略相同')
  await review.trigger('click')
  await flushPromises()
  expect(document.querySelector('[role=dialog]')!.textContent).toContain('确认修改日志保留策略')
  vi.unstubAllGlobals()
})

it('shows the event time in the browser zone and keeps the original ISO in the copied event', async () => {
  const { default: Detail } = await import('../components/logs/LogDetail.vue')
  const event = {
    id: '00000000-0000-4000-8000-000000000003',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'http',
    operation: 'http.request',
    outcome: 'success'
  }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  const local = new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
  expect(wrapper.text()).toContain(local)
  expect(wrapper.text()).toContain('本地 UTC')
  expect(wrapper.text()).not.toContain('2026-10-22T00:00:00Z')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0]).timestamp).toBe('2026-10-22T00:00:00Z')
})

it('labels retained rows as still-reading while a new filter is in flight', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const pending = deferred<any>()
  let first = true
  vi.stubGlobal('$fetch', async (url: string) => {
    if (url === '/api/logs/policy') return policyView
    if (first) {
      first = false
      return { rows: [listRow('00000000-0000-4000-8000-000000000004')], nextCursor: null, status: { dropped: 0 } }
    }
    return pending.promise
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  await router.push('/logs?level=error')
  await flushPromises()
  const stale = wrapper.get('[role=status]').text()
  expect(stale).toContain('正在读取当前筛选')
  expect(stale).toContain('已保留第 1 页的 1 条旧结果（未设筛选）')
  expect(stale).not.toContain('未能读取')
  pending.resolve({ rows: [], nextCursor: null, status: { dropped: 0 } })
  await flushPromises()
  expect(wrapper.text()).toContain('没有符合条件的运行日志')
})
