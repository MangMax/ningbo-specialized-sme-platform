// @vitest-environment happy-dom
// Component/composable seam only: these are not actual Nuxt/browser evidence.
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useLogRead } from '../composables/useLogRead'
import type { LogSummary } from '../lib/logging/contract'
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
  const header = wrapper.get('[data-testid=log-table-scroll] .data-table thead').text()
  for (const label of ['时间', '级别', '来源', '操作', '目标', '结果', '耗时', 'HTTP 状态', '关联标识', '详情'])
    expect(header).toContain(label)
  expect(header).not.toContain('级别 / 时间')
  expect(header).not.toContain('操作 / 来源')
  expect(header).not.toContain('结果 / 耗时')
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

const makeLogRow = (over: Partial<LogSummary> = {}): LogSummary =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'http',
    operation: 'http.request',
    outcome: 'success',
    ...over
  }) as LogSummary

it('describes each source with its real business object, accurate outcome and raw unknown operation', async () => {
  const { describeLogRow, outcomeLabel } = await import('../components/logs/logPresentation')
  // 冻结契约的 method + 安全 route 模板；缺失时只说接口未记录，绝不从 resourceId 猜 URL。
  expect(
    describeLogRow(makeLogRow({ httpMethod: 'GET', httpRoute: '/api/enterprises/:id' })).target.text
  ).toBe('GET /api/enterprises/:id')
  expect(describeLogRow(makeLogRow({ httpMethod: 'POST' })).target.text).toBe('POST · 路由未记录')
  expect(describeLogRow(makeLogRow({ resourceId: 'file-9', resourceType: 'file' })).target).toMatchObject({
    text: '接口未记录',
    missing: true
  })
  // 最长合法 operation(96) 原样保留；已知操作才给中文，未知不硬编含义。
  const longest = 'a' + 'b'.repeat(95)
  expect(longest).toHaveLength(96)
  const unknown = describeLogRow(makeLogRow({ operation: longest }))
  expect(unknown.operationLabel).toBeNull()
  expect(unknown.operationCode).toBe(longest)
  expect(describeLogRow(makeLogRow({ operation: 'task.finished' })).operationLabel).toBe('任务结束')
  // outcome 全部各自成词，unknown/no_record/denied/partial 不并入成功或失败。
  const outcomes: Record<string, string> = {
    started: '已开始',
    success: '成功',
    failure: '失败',
    denied: '已拒绝',
    timeout: '超时',
    cancelled: '已取消',
    unknown: '结果未知',
    no_record: '无记录',
    partial: '部分完成',
    skipped: '已跳过'
  }
  for (const [code, label] of Object.entries(outcomes)) {
    expect(outcomeLabel(code)).toBe(label)
    expect(describeLogRow(makeLogRow({ outcome: code as LogSummary['outcome'] })).outcomeLabel).toBe(label)
  }
  expect(new Set(Object.values(outcomes)).size).toBe(10)
  // 各来源的真实对象。
  expect(describeLogRow(makeLogRow({ source: 'file', fileId: 12, page: 3 })).target).toMatchObject({
    text: '文件 12 · 第 3 页',
    kind: 'file'
  })
  expect(describeLogRow(makeLogRow({ source: 'ocr', fileId: 12, page: 3, counts: { done: 2, total: 3 } })).target.text).toBe(
    '文件 12 · 第 3 页 · 已完成 2/3'
  )
  expect(describeLogRow(makeLogRow({ source: 'import', batchId: 'b-180' })).target.text).toBe('批次 b-180')
  expect(
    describeLogRow(
      makeLogRow({ source: 'export', resourceType: 'export_artifact', resourceId: 'job-9', taskId: 't-9' })
    ).target.text
  ).toBe('导出产物 job-9 · 任务 t-9')
  expect(
    describeLogRow(makeLogRow({ source: 'task', taskId: 't-9', counts: { done: 3, total: 10, failed: 1 } })).target.text
  ).toBe('任务 t-9 · 已完成 3/10 · 失败 1')
  expect(describeLogRow(makeLogRow({ source: 'platform', page: 2, counts: { done: 1, total: 4 } })).target.text).toBe(
    '第 2 页 · 已完成 1/4'
  )
  expect(
    describeLogRow(makeLogRow({ source: 'client', untrustedRelatedRequestId: 'original-180' })).target
  ).toMatchObject({ text: '客户端声称 original-180', untrusted: true })
  expect(describeLogRow(makeLogRow({ source: 'client' })).target).toMatchObject({ missing: true, text: '未记录' })
  expect(describeLogRow(makeLogRow({ source: 'system', counts: { dropped: 3 } })).target.text).toBe('丢弃 3')
  expect(
    describeLogRow(makeLogRow({ source: 'worker', operation: 'enterprise_read.finished', resourceType: 'enterprise', resourceId: 42 }))
      .target.text
  ).toBe('企业 42')
  expect(
    describeLogRow(makeLogRow({ source: 'worker', operation: 'enterprise_read.process.error' })).target
  ).toMatchObject({ text: '未记录', missing: true })
  // 缺失字段明确显示未记录；非 HTTP 行状态显示 —。
  const sparse = describeLogRow(makeLogRow({}))
  expect(sparse.durationText).toBe('未记录')
  expect(sparse.statusText).toBe('未记录')
  expect(sparse.statusMissing).toBe(true)
  expect(describeLogRow(makeLogRow({ source: 'task', taskId: 't-1' })).statusText).toBe('—')
  // 关联列不与目标列重复，且能报告还有几条引用。
  const task = describeLogRow(makeLogRow({ source: 'task', taskId: 't-1', requestId: 'req-1', traceId: 'tr-1' }))
  expect(task.references.map((entry) => entry.value)).toEqual(['req-1', 'tr-1'])
  expect(task.primaryReference?.kind).toBe('请求')
  const http = describeLogRow(makeLogRow({ requestId: 'req-1', traceId: 'tr-1', taskId: 't-1' }))
  expect(http.references).toHaveLength(3)
  expect(http.extraReferenceCount).toBe(2)
  // 最大合法耗时和 128 位标识原样保留，交给列边界截断。
  const longestId = 'r' + 'q'.repeat(127)
  expect(
    describeLogRow(makeLogRow({ durationMs: Number.MAX_SAFE_INTEGER, outcome: 'no_record', requestId: longestId }))
  ).toMatchObject({ durationText: `${Number.MAX_SAFE_INTEGER} ms`, primaryReference: { value: longestId } })
})

it('renders independent desktop columns and keeps long operation, route, outcome, duration and status in their own bounded cells', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const longOperation = 'operation.' + 'x'.repeat(86)
  const longRoute =
    '/api/enterprises/:enterpriseId/records/:recordId/correspondence/:revisionId/:partId'
  const longestId = 'r' + 'q'.repeat(127)
  const rows: LogSummary[] = [
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000201',
      source: 'http',
      level: 'warn',
      operation: longOperation,
      outcome: 'no_record',
      httpMethod: 'POST',
      httpRoute: longRoute,
      durationMs: Number.MAX_SAFE_INTEGER,
      statusCode: 500,
      requestId: longestId,
      traceId: 'trace-201',
      resourceId: 'file-9',
      resourceType: 'file'
    }),
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000202',
      source: 'file',
      operation: 'file.render.page',
      fileId: 12,
      page: 3,
      durationMs: 42
    }),
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000203',
      source: 'import',
      operation: 'import.execution',
      outcome: 'partial',
      batchId: 'batch-180',
      counts: { done: 3, total: 5, failed: 1 }
    }),
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000204',
      source: 'client',
      operation: 'client.tasks.interaction_failure',
      outcome: 'failure',
      errorCode: 'interaction',
      requestId: 'intake-1',
      untrustedRelatedRequestId: 'original-180'
    }),
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000205',
      source: 'task',
      operation: 'task.finished',
      outcome: 'unknown',
      taskId: 'task-9'
    })
  ]
  vi.stubGlobal('$fetch', async (url: string) => {
    if (url === '/api/logs/policy') return policyView
    return { rows, nextCursor: null, status: { dropped: 0 } }
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
  const scroller = wrapper.get('[data-testid=log-table-scroll]')
  const header = scroller.get('.data-table thead').text()
  for (const label of ['时间', '级别', '来源', '操作', '目标', '结果', '耗时', 'HTTP 状态', '关联标识', '详情'])
    expect(header).toContain(label)
  expect(header).not.toContain(' / ')
  const bodyRows = scroller.findAll('.data-table tbody tr')
  expect(bodyRows).toHaveLength(rows.length)
  const first = bodyRows[0]!.findAll('td')
  expect(first).toHaveLength(10)
  for (const cell of first) expect(cell.classes()).toContain('overflow-hidden')
  expect(first[0]!.get('time').attributes('datetime')).toBe(rows[0]!.timestamp)
  expect(first[3]!.text()).toBe(longOperation)
  expect(first[3]!.get('span[title]').attributes('title')).toBe(longOperation)
  expect(first[4]!.text()).toBe(`POST ${longRoute}`)
  expect(first[4]!.text()).not.toContain('file-9')
  expect(first[5]!.text()).toBe('无记录')
  expect(first[6]!.text()).toBe(`${Number.MAX_SAFE_INTEGER} ms`)
  expect(first[7]!.text()).toBe('500')
  expect(first[8]!.text()).toContain(longestId)
  expect(first[9]!.get('[data-log-detail]').text()).toBe('查看')
  // 相邻结果/耗时列各自有边界，不共用一个无界 flex。
  expect(first[5]!.text()).not.toContain('ms')
  expect(first[6]!.text()).not.toContain('无记录')
  // 真实业务对象进入目标列，不是只认 task/request/trace。
  const file = bodyRows[1]!.findAll('td')
  expect(file[4]!.text()).toBe('文件 12 · 第 3 页')
  expect(file[7]!.text()).toBe('—')
  const imported = bodyRows[2]!.findAll('td')
  expect(imported[4]!.text()).toBe('批次 batch-180 · 已完成 3/5 · 失败 1')
  expect(imported[5]!.text()).toBe('部分完成')
  const client = bodyRows[3]!.findAll('td')
  expect(client[4]!.text()).toContain('客户端声称 original-180')
  expect(client[4]!.text()).toContain('UNTRUSTED')
  const oldTask = bodyRows[4]!.findAll('td')
  expect(oldTask[4]!.text()).toBe('任务 task-9')
  expect(oldTask[5]!.text()).toBe('结果未知')
  expect(oldTask[6]!.text()).toBe('未记录')
  expect(oldTask[7]!.text()).toBe('—')
})

it('labels the 390px summary with a 44px detail target and lets long IDs wrap without escaping', async () => {
  const { default: Page } = await import('../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const longestId = 'r' + 'q'.repeat(127)
  const longRoute = '/api/enterprises/:enterpriseId/records/:recordId/parts/:partId'
  const rows: LogSummary[] = [
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000301',
      source: 'http',
      operation: 'http.request',
      outcome: 'denied',
      httpMethod: 'GET',
      httpRoute: longRoute,
      durationMs: Number.MAX_SAFE_INTEGER,
      statusCode: 500,
      requestId: longestId
    }),
    makeLogRow({
      id: '00000000-0000-4000-8000-000000000302',
      source: 'file',
      operation: 'file.render.page',
      fileId: 12,
      page: 3,
      durationMs: 42
    })
  ]
  vi.stubGlobal('$fetch', async (url: string) => {
    if (url === '/api/logs/policy') return policyView
    return { rows, nextCursor: null, status: { dropped: 0 } }
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
  const items = wrapper.get('[data-testid=log-card-list]').findAll('li')
  expect(items).toHaveLength(2)
  const first = items[0]!
  for (const label of ['操作', '来源', '结果', '目标', 'HTTP 状态', '耗时', '关联'])
    expect(first.text()).toContain(label)
  expect(first.text()).toContain('HTTP 接口')
  expect(first.text()).toContain('http')
  expect(first.text()).toContain('已拒绝')
  expect(first.text()).toContain(longRoute)
  expect(first.text()).toContain(longestId)
  expect(first.findAll('.break-all').length).toBeGreaterThan(0)
  const detail = first.get('[data-log-detail]')
  expect(detail.text()).toBe('查看')
  expect(detail.classes()).toContain('min-h-11')
  expect(items[1]!.text()).toContain('文件 12 · 第 3 页')
  expect(items[1]!.text()).toContain('42 ms')
})

it('shows and copies the safe HTTP method and route template in the classified detail', async () => {
  const { default: Detail } = await import('../components/logs/LogDetail.vue')
  const event = {
    id: '00000000-0000-4000-8000-000000000206',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'error',
    source: 'http',
    operation: 'http.request',
    outcome: 'failure',
    httpMethod: 'GET',
    httpRoute: '/api/jobs/:id',
    statusCode: 500,
    errorCode: 'operation_failed',
    requestId: 'req-206'
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('HTTP 方法')
  expect(wrapper.text()).toContain('接口路由模板')
  expect(wrapper.text()).toContain('/api/jobs/:id')
  expect(wrapper.text()).toContain('安全失败码')
  expect(wrapper.text()).toContain('operation_failed')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({
    httpMethod: 'GET',
    httpRoute: '/api/jobs/:id',
    errorCode: 'operation_failed'
  })
})
