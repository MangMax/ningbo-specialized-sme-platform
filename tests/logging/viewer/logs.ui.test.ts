// @vitest-environment happy-dom
import { chooseCalendarSelect } from '../../support/calendar-select'
// Component/composable seam only: these are not actual Nuxt/browser evidence.
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useLogRead } from '../../../composables/useLogRead'
import type { FieldCapturedLogEvent, LogSummary } from '../../../lib/logging/contract'
// Model reduced-motion preference in happy-dom; real browser checks retain the
// production transitions and exercise the actual Tabs/Sheet interaction.
vi.mock('motion-v', async (original) => {
  const actual = await original<typeof import('motion-v')>()
  const { ref } = await import('vue')
  return { ...actual, useReducedMotion: () => ref(true) }
})
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Nuxt auto-imports Icon in the app; Vitest needs a stand-in. */
const IconStub = { props: ['name'], template: '<span class="icon-stub" :data-icon="name"></span>' }
/** Collection switches now live inside the module Sheet; open the drawer first. */
async function openModule(wrapper: any, prefix = 'integration', key = 'nuxt-nitro') {
  const trigger = wrapper.get('[data-testid="log-module-row-' + prefix + '-' + key + '"]')
  if (trigger.attributes('aria-expanded') !== 'true') {
    await trigger.trigger('click')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
async function closeModule(_wrapper: any, _prefix = 'integration', _key = 'nuxt-nitro') {
  const done = document.querySelector('[data-testid=log-module-sheet-done]') as HTMLButtonElement | null
  if (!done) return
  done.click()
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const domGet = (id: string) => new DOMWrapper(document.getElementById(id) as Element)
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
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
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
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('#log-max-bytes').setValue('1048576')
  await wrapper.get('form').trigger('submit')
  expect(writes).toBe(0)
  await flushPromises()
  const confirm = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('确认保存配置')
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
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const calls: { url: string; options: any }[] = []
  const event = {
    id: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-10-22T00:00:00Z',
    source: 'task',
    module: 'sme-roster',
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
  await router.push('/logs?taskId=task-182&module=sme-roster&source=task')
  await router.isReady()
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(calls.find((c) => c.url === '/api/logs')!.options.query).toMatchObject({
    taskId: 'task-182', module: 'sme-roster', source: 'task'
  })
  expect(wrapper.get('#log-module').text()).toContain('优质中小企业')
  expect(wrapper.get('[data-log-field="module"]').text()).toBe('优质中小企业')
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
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('优质中小企业')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('safe_code')
  const button = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('复制脱敏事件')
  )!
  button.click()
  await flushPromises()
  expect(copy).toHaveBeenCalledOnce()
  expect(JSON.parse(copy.mock.calls[0]![0])).toMatchObject({ taskId: 'task-182', module: 'sme-roster' })
  expect(copy.mock.calls[0]![0]).not.toContain('private-nonce')
  expect(
    calls.every(
      (c) => c.options.headers['x-log-browser'] === '1' && !c.options.headers.authorization
    )
  ).toBe(true)
  vi.unstubAllGlobals()
})

it('requires an explicit chronological range and freezes all applied filters before one bounded clear', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
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
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
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
  const { default: Page } = await import('../../../pages/logs.vue')
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
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
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
  expect(wrapper.text()).toContain('未标注')
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
  const { default: Filters } = await import('../../../components/logs/LogFilters.vue')
  const wrapper = mount(Filters, { props: { filter: { requestId: 'req-180' } }, attachTo: document.body })
  wrappers.push(wrapper)
  expect(wrapper.findAll('[data-slot="field-group"]')).toHaveLength(2)
  expect(wrapper.findAll('[data-slot="field"]')).toHaveLength(13)
  for (const label of wrapper.findAll('label[for]')) {
    expect(document.getElementById(label.attributes('for')!)).not.toBeNull()
    expect(label.element.closest('[data-slot="field"]')).not.toBeNull()
  }
})

it('shows and copies only a validated UNTRUSTED client request reference, distinct from intake IDs', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
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

// 真实目录：11 个采集器全部 supported/configurable，并带页面分组元数据。
const integrationCatalog = [
  { key: 'nuxt-nitro', label: 'Nuxt / Nitro 请求', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'mcp-toolkit', label: 'MCP Toolkit 模块上下文', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'tus', label: 'tus 服务端回调', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'application', label: '应用手动埋点', state: 'supported', configurable: true, category: 'business', runtimes: ['node', 'browser'] },
  { key: 'browser', label: '浏览器原生异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'vue', label: 'Vue 异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'tus-client', label: 'tus 客户端', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'drizzle', label: 'Drizzle 数据库', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'embedpdf', label: 'EmbedPDF', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'pinia-colada', label: 'Colada 查询', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'vue-router', label: 'Vue Router', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] }
] as const
// 旧目录独立 fixture：六项已接入、五项仍标记未接入；用于保留旧 catalog 的兼容覆盖。
const legacyIntegrationCatalog = [
  { key: 'nuxt-nitro', label: 'Nuxt / Nitro 请求', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'mcp-toolkit', label: 'MCP Toolkit 模块上下文', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'tus', label: 'tus 服务端回调', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'application', label: '应用手动埋点', state: 'supported', configurable: true, category: 'business', runtimes: ['node', 'browser'] },
  { key: 'browser', label: '浏览器原生异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'vue', label: 'Vue 异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'tus-client', label: 'tus 客户端', state: 'unwired', configurable: false, category: 'technical', runtimes: ['browser'] },
  { key: 'drizzle', label: 'Drizzle 数据库', state: 'unwired', configurable: false, category: 'technical', runtimes: ['node'] },
  { key: 'embedpdf', label: 'EmbedPDF', state: 'unwired', configurable: false, category: 'technical', runtimes: ['browser'] },
  { key: 'pinia-colada', label: 'Colada 查询', state: 'unwired', configurable: false, category: 'technical', runtimes: ['browser'] },
  { key: 'vue-router', label: 'Vue Router', state: 'unwired', configurable: false, category: 'technical', runtimes: ['browser'] }
] as const
const sourceKeys = [
  'http', 'mcp', 'task', 'worker', 'platform', 'file', 'ocr', 'import', 'export', 'client', 'system'
] as const
type TestRule = { enabled: boolean; minLevel: 'debug' | 'info' | 'warn' | 'error' }
const defaultRule = (): TestRule => ({ enabled: true, minLevel: 'debug' })
const defaultCollection = () => ({
  sources: Object.fromEntries(sourceKeys.map((key) => [key, defaultRule()])),
  integrations: Object.fromEntries(
    integrationCatalog
      .filter((entry) => entry.state === 'supported')
      .map((entry) => [entry.key, defaultRule()])
  )
})
const policyView = {
  retentionDays: 7,
  maxBytes: 536870912,
  storageBytes: 4096,
  pruned: 0,
  cleared: 0,
  status: { dropped: 0, unavailable: false, since: '2026-10-22T00:00:00.000Z' },
  collection: defaultCollection(),
  catalog: { integrations: integrationCatalog },
  revision: 1
}
const policyResponse = () => ({
  ...policyView,
  collection: defaultCollection(),
  catalog: { integrations: integrationCatalog }
})
const legacyCollection = () => ({
  sources: Object.fromEntries(sourceKeys.map((key) => [key, defaultRule()])),
  integrations: Object.fromEntries(
    legacyIntegrationCatalog
      .filter((entry) => entry.state === 'supported')
      .map((entry) => [entry.key, defaultRule()])
  )
})
const legacyPolicyView = {
  ...policyView,
  collection: legacyCollection(),
  catalog: { integrations: legacyIntegrationCatalog }
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
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const pending = deferred<any>()
  vi.stubGlobal('$fetch', async (url: string) => (url === '/api/logs/policy' ? policyView : pending.promise))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  // 首次读取：按每页条数铺骨架（桌面行 / 窄屏卡），分页占位，而不是把卡收成一条表头。
  expect(wrapper.findAll('[data-testid=log-row-skeleton]')).toHaveLength(25)
  expect(wrapper.findAll('[data-testid=log-card-skeleton]')).toHaveLength(25)
  // 骨架与正常结构对齐：桌面 10 列、窄屏 6 个带标签行，而不是旧的 4 行占位。
  expect(wrapper.findAll('[data-testid=log-row-skeleton]')[0]!.findAll('td')).toHaveLength(10)
  expect(
    wrapper.findAll('[data-testid=log-card-skeleton]')[0]!.findAll('[data-skeleton-row]')
  ).toHaveLength(6)
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('正在读取…')
  pending.resolve({ rows: [listRow('00000000-0000-4000-8000-000000000001')], nextCursor: null, status: { dropped: 0 } })
  await flushPromises()
  expect(wrapper.findAll('[data-testid=log-row-skeleton]')).toHaveLength(0)
  expect(wrapper.findAll('[data-testid=log-card-skeleton]')).toHaveLength(0)
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('本页 1 条 · 第 1 页')
})

it('returns the result list to its first row after a page change and keeps filter and page size', async () => {
  const { default: Page } = await import('../../../pages/logs.vue')
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
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
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
  for (const label of ['时间', '级别', '来源', '操作', '目标', '结果', '耗时', 'HTTP 状态', '详情'])
    expect(header).toContain(label)
  expect(header).not.toContain('级别 / 时间')
  expect(header).not.toContain('操作 / 来源')
  expect(header).not.toContain('结果 / 耗时')
  expect(wrapper.text()).not.toContain('共 0')
})

it('does not offer a policy review until a value actually differs from the active policy', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  vi.stubGlobal('$fetch', async () => policyView)
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  const review = wrapper.findAll('button').find((b) => b.text() === '核对日志配置修改')!
  expect((review.element as HTMLButtonElement).disabled).toBe(true)
  expect(wrapper.text()).toContain('当前配置与已生效配置相同')
  await wrapper.get('#log-retention-days').setValue('8')
  expect((review.element as HTMLButtonElement).disabled).toBe(false)
  expect(wrapper.text()).not.toContain('当前配置与已生效配置相同')
  await review.trigger('click')
  await flushPromises()
  expect(document.querySelector('[role=dialog]')!.textContent).toContain('核对日志配置修改')
  vi.unstubAllGlobals()
})

it('reviews only changed collection rules, sends changed maps, and refreshes effective controls', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  const { default: Select } = await import('../../../components/ui/select/Select.vue')
  let policy = policyResponse()
  const writes: any[] = []
  vi.stubGlobal('$fetch', async (url: string, options: any = {}) => {
    expect(url).toBe('/api/logs/policy')
    if (options.method === 'PATCH') {
      writes.push(options.body)
      const next = policyResponse()
      next.collection.sources.http = { enabled: false, minLevel: 'debug' }
      next.collection.sources.mcp = { enabled: true, minLevel: 'warn' }
      policy = next
      return next
    }
    return policy
  })
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  await openModule(wrapper, 'source', 'http')
  const switchState = () => domGet('log-source-http-enabled').attributes('data-state')
  expect(switchState()).toBe('checked')
  await domGet('log-source-http-enabled').trigger('click')
  expect(switchState()).toBe('unchecked')
  // 关闭后级别选择停用，但草稿值保留。
  expect((domGet('log-source-http-min-level').element as HTMLButtonElement).disabled).toBe(true)
  await domGet('log-source-http-enabled').trigger('click')
  expect(domGet('log-source-http-min-level').text()).toBe('调试')
  await domGet('log-source-http-enabled').trigger('click')
  await closeModule(wrapper, 'source', 'http')

  // 通过真实 Select 组件改 MCP 的最低级别，而不是伪造原生 select。
  await openModule(wrapper, 'source', 'mcp')
  const levelTrigger = domGet('log-source-mcp-min-level')
  const select = wrapper
    .findAllComponents(Select)
    .find((candidate) => candidate.element.contains(levelTrigger.element))!
  select.vm.$emit('update:modelValue', 'warn')
  await flushPromises()
  expect(levelTrigger.text()).toBe('警告')
  await closeModule(wrapper, 'source', 'mcp')

  const review = wrapper.get('[data-testid=log-policy-review]')
  expect((review.element as HTMLButtonElement).disabled).toBe(false)
  await review.trigger('click')
  await flushPromises()
  let dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('核对日志配置修改')
  expect(dialog.textContent).toContain('来源采集 · HTTP 接口')
  expect(dialog.textContent).toContain('来源采集 · MCP 调用')
  expect(dialog.textContent).toContain('关闭 · 级别保留调试')
  expect(dialog.textContent).toContain('警告')
  // 未变化的 9 条来源规则不列出来。
  expect(dialog.textContent).not.toContain('后台任务')
  expect(writes).toHaveLength(0)
  ;(
    Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '取消'
    ) as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(writes).toHaveLength(0)

  await review.trigger('click')
  await flushPromises()
  ;(
    document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(writes).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      collection: {
        sources: {
          http: { enabled: false, minLevel: 'debug' },
          mcp: { enabled: true, minLevel: 'warn' }
        }
      }
    }
  ])
  expect(wrapper.get('[data-testid=log-module-row-source-http]').text()).toContain('关闭')
  expect(wrapper.get('[data-testid=log-module-row-source-mcp]').text()).toContain('最低警告')
  // 保存反馈只说「已保存」：这次 PATCH 可能同时改了保留策略，不能断言历史不受影响。
  expect(wrapper.text()).toContain('日志配置已保存。')
  expect(wrapper.text()).not.toContain('已有记录不受影响')
  vi.unstubAllGlobals()
})

it('never claims history is untouched when the save can shrink retention', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  let policy = policyResponse()
  const writes: any[] = []
  vi.stubGlobal('$fetch', async (_url: string, options: any = {}) => {
    if (options.method === 'PATCH') {
      writes.push(options.body)
      policy = { ...policyResponse(), retentionDays: 3 }
      return policy
    }
    return policy
  })
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('#log-retention-days').setValue('3')
  await wrapper.get('[data-testid=log-policy-review]').trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('保留天数：7 天 → 3 天')
  // 保留策略缩短可能物理清理日志：确认文案不能同时声称「不删除已有记录」。
  expect(dialog.textContent).toContain('保留策略调整可能清理已有日志')
  expect(dialog.textContent).not.toContain('不删除已有记录')
  ;(
    document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement
  ).click()
  await flushPromises()
  // 这次 PATCH 真实改了保留天数，成功反馈只能报「已保存」。
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ retentionDays: 3 })
  expect(wrapper.text()).toContain('日志配置已保存。')
  expect(wrapper.text()).not.toContain('已有记录不受影响')
  expect(wrapper.text()).not.toContain('对后续日志生效')
  vi.unstubAllGlobals()
})

it('reviews and PATCHes only the shared application rule when it is the only change', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  let policy = policyResponse()
  const writes: any[] = []
  vi.stubGlobal('$fetch', async (_url: string, options: any = {}) => {
    if (options.method === 'PATCH') {
      writes.push(options.body)
      const next = policyResponse()
      next.collection.integrations.application = { enabled: false, minLevel: 'debug' }
      policy = next
      return next
    }
    return policy
  })
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  await openModule(wrapper, 'integration', 'application')
  await domGet('log-integration-application-enabled').trigger('click')
  await closeModule(wrapper, 'integration', 'application')
  await wrapper.get('[data-testid=log-policy-review]').trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[role=dialog]')!
  // application 属于业务区，只出现一条跨端共享规则。
  expect(dialog.textContent).toContain('业务埋点 · 应用手动埋点')
  expect(dialog.textContent).toContain('关闭 · 级别保留调试')
  expect(writes).toHaveLength(0)
  ;(
    Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '取消'
    ) as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(writes).toHaveLength(0)
  expect(wrapper.get('[data-testid=log-module-row-integration-application]').text()).toContain('关闭')
  await wrapper.get('[data-testid=log-policy-review]').trigger('click')
  await flushPromises()
  ;(
    document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(writes).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      collection: { integrations: { application: { enabled: false, minLevel: 'debug' } } }
    }
  ])
  expect(wrapper.get('[data-testid=log-module-row-integration-application]').text()).toContain('关闭')
  vi.unstubAllGlobals()
})

it('keeps the edited rule draft when saving the configuration fails', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  vi.stubGlobal('$fetch', async (_url: string, options: any = {}) => {
    if (options.method === 'PATCH')
      throw { data: { error: { code: 'policy_capacity_pending' } } }
    return policyResponse()
  })
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  await openModule(wrapper, 'source', 'http')
  await domGet('log-source-http-enabled').trigger('click')
  await closeModule(wrapper, 'source', 'http')
  await wrapper.get('[data-testid=log-policy-review]').trigger('click')
  await flushPromises()
  ;(
    document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(wrapper.text()).toContain('原策略仍生效')
  await openModule(wrapper, 'source', 'http')
  expect(domGet('log-source-http-enabled').attributes('data-state')).toBe('unchecked')
  expect((domGet('log-source-http-min-level').element as HTMLButtonElement).disabled).toBe(true)
  vi.unstubAllGlobals()
})

it('groups the real catalog into technical 4+6 and business 10+1 with one shared application rule', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  vi.stubGlobal('$fetch', async () => policyView)
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  // 总 22 个模块入口；主列表没有任何内联开关。
  expect(wrapper.findAll('[data-testid^=log-module-row-]')).toHaveLength(22)
  expect(document.querySelector('[data-slot=switch]')).toBeNull()
  expect(wrapper.findAll('input[type=checkbox]')).toHaveLength(0)
  expect(wrapper.findAll('select')).toHaveLength(0)
  expect(wrapper.findAll('details')).toHaveLength(0)
  expect(wrapper.find('[data-testid=log-unwired-integrations]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('未接入的技术集成')
  const rowCount = (testid: string) =>
    wrapper.findAll('[data-testid=' + testid + '] [data-testid^=log-module-row-]').length
  expect(rowCount('log-technical-node')).toBe(4)
  expect(rowCount('log-technical-browser')).toBe(6)
  expect(rowCount('log-business-shared')).toBe(1)
  expect(rowCount('log-business-node')).toBe(10)
  expect(rowCount('log-business-browser')).toBe(1)
  // application 只出现一次，放在业务区并明确服务端与客户端共用，不伪装成两条开关。
  expect(wrapper.findAll('[data-testid=log-module-row-integration-application]')).toHaveLength(1)
  expect(wrapper.get('[data-testid=log-business-shared]').text()).toContain('服务端与客户端共用')
  expect(wrapper.get('[data-testid=log-collection-integrations]').text()).not.toContain(
    '应用手动埋点'
  )
  // AND / 更严格级别只在一处说明（技术集成），业务区不再重复同一句。
  expect(wrapper.get('[data-testid=log-collection-integrations]').text()).toContain(
    '技术集成与来源须同时开启'
  )
  expect(wrapper.get('[data-testid=log-collection-sources]').text()).not.toContain(
    '也包括技术集成采集的事件'
  )
  expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual([
    '技术集成',
    '业务埋点',
    '保留策略',
    '范围清理'
  ])
  vi.unstubAllGlobals()
})

it('lists legacy unwired catalog entries as explicitly not configurable instead of disabled switches', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  vi.stubGlobal('$fetch', async () => legacyPolicyView)
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  // 旧目录独立 fixture：11 个来源 + 6 个已接入集成；未接入项不伪装成开关。
  expect(wrapper.findAll('[data-testid^=log-module-row-]')).toHaveLength(17)
  expect(document.querySelector('[data-slot=switch]')).toBeNull()
  expect(wrapper.findAll('input[type=checkbox]')).toHaveLength(0)
  expect(wrapper.text()).toContain('未接入的技术集成（5）')
  expect(wrapper.text()).not.toContain('Drizzle 数据库')
  expect(wrapper.find('[data-testid=log-module-row-integration-drizzle]').exists()).toBe(false)
  const trigger = wrapper
    .findAll('button')
    .find((button) => button.text().includes('未接入的技术集成'))!
  await trigger.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Drizzle 数据库')
  expect(wrapper.text()).toContain('未接入，不可配置')
  expect(wrapper.find('#log-integration-drizzle-enabled').exists()).toBe(false)
  vi.unstubAllGlobals()
})

it('keeps legacy retention usable and never posts empty collection overrides', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  let current: any = {
    retentionDays: 7,
    maxBytes: 536870912,
    storageBytes: 4096,
    pruned: 0,
    cleared: 0,
    status: {}
  }
  let body: any
  vi.stubGlobal('$fetch', async (_url: string, options: any = {}) => {
    if (options.method === 'PATCH') {
      body = options.body
      current = { ...current, retentionDays: 8 }
      return current
    }
    return current
  })
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.find('[data-testid=log-collection-sources]').exists()).toBe(false)
  expect(wrapper.findAll('[data-slot=switch]')).toHaveLength(0)
  expect(wrapper.text()).not.toContain('技术集成')
  await wrapper.get('#log-retention-days').setValue('8')
  await wrapper.get('[data-testid=log-policy-review]').trigger('click')
  await flushPromises()
  ;(
    document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement
  ).click()
  await flushPromises()
  expect(body).toEqual({ retentionDays: 8, maxBytes: 536870912 })
  expect((wrapper.get('#log-retention-days').element as HTMLInputElement).value).toBe('8')
  vi.unstubAllGlobals()
})

it('shows origin only when present and copies only the fixed origin fields', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const event = {
    id: '00000000-0000-4000-8000-000000000501',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'file',
    operation: 'file.upload',
    outcome: 'success',
    origin: {
      runtime: 'node',
      integration: 'tus',
      capture: 'hook',
      execution: 'worker',
      privateMarker: 'PRIVATE-ORIGIN'
    }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('采集信息')
  expect(wrapper.text()).toContain('Node（node）')
  expect(wrapper.text()).toContain('tus 服务端回调（tus）')
  expect(wrapper.text()).toContain('生命周期钩子（hook）')
  expect(wrapper.text()).toContain('工作进程（worker）')
  expect(wrapper.text()).toContain('可与 Node 运行时同时存在')
  expect(wrapper.text()).not.toContain('PRIVATE-ORIGIN')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0]).origin).toEqual({
    runtime: 'node',
    integration: 'tus',
    capture: 'hook',
    execution: 'worker'
  })
})

it('marks a browser origin as self-reported and omits the section for historical events', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  let event: any = {
    id: '00000000-0000-4000-8000-000000000502',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'warn',
    source: 'client',
    operation: 'client.vue.error',
    outcome: 'failure',
    origin: { runtime: 'browser', integration: 'vue', capture: 'hook', execution: 'page' }
  }
  vi.stubGlobal('$fetch', vi.fn(async () => event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('浏览器（browser，客户端自报）')
  expect(wrapper.text()).toContain('Vue 异常（vue）')
  expect(wrapper.text()).toContain('页面（page）')
  event = { ...event, id: '00000000-0000-4000-8000-000000000503', origin: undefined }
  await wrapper.setProps({ id: event.id })
  await flushPromises()
  expect(wrapper.text()).not.toContain('采集信息')
  expect(wrapper.text()).not.toContain('客户端自报）')
})

it('shows the event time in the browser zone and keeps the original ISO in the copied event', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
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
  const { default: Page } = await import('../../../pages/logs.vue')
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
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
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
  const { describeLogRow, outcomeLabel, formatCounts, errorCodeView } = await import('../../../components/logs/logPresentation')
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
  expect(
    describeLogRow(makeLogRow({
      source: 'file', operation: 'file.upload',
      tus: { uploadId: '0123456789abcdef0123456789abcdef', phase: 'created', method: 'POST', size: 10, offset: 0 }
    })).target
  ).toMatchObject({ text: '上传 0123456789abcdef0123456789abcdef', missing: false })
  expect(describeLogRow(makeLogRow({ source: 'ocr', fileId: 12, page: 3, counts: { done: 2, total: 3 } })).target.text).toBe(
    '文件 12 · 第 3 页 · 已处理 2/3'
  )
  expect(describeLogRow(makeLogRow({ source: 'import', batchId: 'b-180' })).target.text).toBe('批次 b-180')
  expect(
    describeLogRow(
      makeLogRow({ source: 'export', resourceType: 'export_artifact', resourceId: 'job-9', taskId: 't-9' })
    ).target.text
  ).toBe('导出产物 job-9 · 任务 t-9')
  expect(
    describeLogRow(makeLogRow({ source: 'task', taskId: 't-9', counts: { done: 3, total: 10, failed: 1 } })).target.text
  ).toBe('任务 t-9 · 已处理 3/10 · 失败 1')
  expect(describeLogRow(makeLogRow({ source: 'platform', page: 2, counts: { done: 1, total: 4 } })).target.text).toBe(
    '第 2 页 · 已处理 1/4'
  )
  expect(
    describeLogRow(makeLogRow({ source: 'client', untrustedRelatedRequestId: 'original-180' })).target
  ).toMatchObject({ text: '客户端声称 original-180', untrusted: true })
  expect(describeLogRow(makeLogRow({ source: 'client' })).target).toMatchObject({ missing: true, text: '未记录' })
  expect(describeLogRow(makeLogRow({ source: 'system', counts: { dropped: 3 } })).target.text).toBe('丢弃 3')
  // done 是“已处理”，不能写成“已完成”；failed/dropped 原值保留；retry 的 done 按尝试次数展示。
  expect(formatCounts({ done: 5 })).toBe('已处理 5')
  expect(formatCounts({ done: 5, total: 8 })).toBe('已处理 5/8')
  expect(formatCounts({ done: 5, total: 8, failed: 2, dropped: 1 }, 'task.progress')).toBe(
    '已处理 5/8 · 失败 2 · 丢弃 1'
  )
  expect(formatCounts({ done: 3 }, 'platform.query_list.retry')).toBe('第 3 次重试')
  expect(formatCounts({ total: 4 }, 'platform.batch.retry')).toBe('共 4')
  expect(formatCounts({ done: 5, total: 8 })).not.toContain('完成')
  // 失败码只展示安全原码；不翻译，也不从 outcome 反推具体码。
  expect(
    describeLogRow(makeLogRow({ outcome: 'failure', errorCode: 'job_failed' }))
  ).toMatchObject({ errorCodeText: 'job_failed', errorCodePresent: true, errorCodeApplicable: true })
  expect(describeLogRow(makeLogRow({ outcome: 'failure' }))).toMatchObject({
    errorCodeText: '不适用',
    errorCodePresent: false,
    errorCodeApplicable: false
  })
  expect(describeLogRow(makeLogRow({ source: 'task', operation: 'task.finished', outcome: 'failure' }))).toMatchObject({
    errorCodeText: '未记录',
    errorCodePresent: false,
    errorCodeApplicable: true
  })
  expect(describeLogRow(makeLogRow({ outcome: 'partial' }))).toMatchObject({
    errorCodeText: '不适用',
    errorCodePresent: false
  })
  expect(describeLogRow(makeLogRow({ outcome: 'success' }))).toMatchObject({
    errorCodeText: '不适用',
    errorCodePresent: false,
    errorCodeApplicable: false
  })
  expect(
    describeLogRow(makeLogRow({ source: 'client', outcome: 'failure', errorCode: 'interaction' }))
  ).toMatchObject({ errorCodeText: 'interaction', errorCodePresent: true })
  expect(errorCodeView(makeLogRow({ outcome: 'failure' })).text).toBe('不适用')
  expect(errorCodeView(makeLogRow({ source: 'task', operation: 'task.finished', outcome: 'failure' })).text).toBe('未记录')
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

it('labels all 21 client library operations, five Drizzle verbs and fixed connection purposes', async () => {
  const {
    operationLabel,
    resourceTypeLabel,
    resourceIdLabel,
    CONNECTION_PURPOSE_LABELS,
    describeLogRow
  } = await import('../../../components/logs/logPresentation')
  const clientOperations = [
    ['client.tus.upload_started', 'tus 上传开始'],
    ['client.tus.upload_ready', 'tus 上传地址可用'],
    ['client.tus.upload_success', 'tus 上传完成'],
    ['client.tus.upload_failure', 'tus 上传失败'],
    ['client.embedpdf.log_debug', 'EmbedPDF 调试日志'],
    ['client.embedpdf.log_info', 'EmbedPDF 信息日志'],
    ['client.embedpdf.log_warn', 'EmbedPDF 警告日志'],
    ['client.embedpdf.log_error', 'EmbedPDF 错误日志'],
    ['client.embedpdf.startup_failure', 'EmbedPDF 启动失败'],
    ['client.embedpdf.document_ready', 'EmbedPDF 文档就绪'],
    ['client.embedpdf.document_failure', 'EmbedPDF 文档加载失败'],
    ['client.colada.query_success', 'Colada 查询成功'],
    ['client.colada.query_failure', 'Colada 查询失败'],
    ['client.colada.mutation_success', 'Colada 变更成功'],
    ['client.colada.mutation_failure', 'Colada 变更失败'],
    ['client.router.navigation_success', '路由跳转成功'],
    ['client.router.navigation_aborted', '路由跳转被中止'],
    ['client.router.navigation_cancelled', '路由跳转被取消'],
    ['client.router.navigation_duplicated', '路由跳转重复'],
    ['client.router.navigation_failure', '路由跳转失败'],
    ['client.router.navigation_error', '路由跳转错误']
  ] as const
  expect(clientOperations).toHaveLength(21)
  for (const [code, label] of clientOperations) expect(operationLabel(code)).toBe(label)
  // Drizzle 钩子只记录执行前尝试；五个动词都不能读成成功或已完成。
  for (const verb of ['select', 'insert', 'update', 'delete', 'other']) {
    const label = operationLabel(`db.query.${verb}`)!
    expect(label).toContain(verb === 'other' ? '其他' : verb.toUpperCase())
    expect(label).not.toContain('成功')
    expect(label).not.toContain('已完成')
  }
  expect(resourceTypeLabel('database_connection')).toBe('数据库连接')
  expect(Object.keys(CONNECTION_PURPOSE_LABELS)).toHaveLength(7)
  for (const [purpose, label] of Object.entries(CONNECTION_PURPOSE_LABELS)) {
    expect(resourceIdLabel('database_connection', purpose)).toBe(`${label}（${purpose}）`)
  }
  expect(resourceIdLabel('database_connection', 'custom')).toBe('custom')
  expect(resourceIdLabel('export_artifact', 'job-9')).toBe('job-9')
  expect(
    describeLogRow(
      makeLogRow({
        source: 'system',
        operation: 'db.query.select',
        resourceType: 'database_connection',
        resourceId: 'primary'
      })
    ).target.text
  ).toBe('数据库连接 主业务库（primary）')
})

it('renders independent desktop columns and keeps long operation, route, outcome, duration and status in their own bounded cells', async () => {
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const longOperation = 'operation.' + 'x'.repeat(86)
  const longRoute =
    '/api/enterprises/:enterpriseId/records/:recordId/correspondence/:revisionId/:partId'
  const longestId = 'r' + 'q'.repeat(127)
  const longErrorCode = 'operation_failed_' + 'x'.repeat(47)
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
      resourceType: 'file',
      errorCode: longErrorCode
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
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  const scroller = wrapper.get('[data-testid=log-table-scroll]')
  const header = scroller.get('.data-table thead').text()
  for (const label of ['时间', '级别', '来源', '操作', '目标', '结果', '失败码', '耗时', 'HTTP 状态', '详情'])
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
  // 失败码是独立列：安全原码 + title，长码靠 truncate 约束，不挤进结果/耗时。
  expect(first[6]!.text()).toBe(longErrorCode)
  expect(first[6]!.get('span[title]').attributes('title')).toBe(longErrorCode)
  expect(first[6]!.get('span').classes()).toContain('truncate')
  expect(first[6]!.text()).not.toContain('无记录')
  expect(first[7]!.text()).toBe(`${Number.MAX_SAFE_INTEGER} ms`)
  expect(first[8]!.text()).toBe('500')
  expect(header).not.toContain('关联标识')
  expect(first[9]!.get('[data-log-detail]').text()).toBe('查看')
  // 相邻结果/失败码/耗时列各自有边界，不共用一个无界 flex。
  expect(first[5]!.text()).not.toContain('ms')
  expect(first[7]!.text()).not.toContain('无记录')
  // 真实业务对象进入目标列，不是只认 task/request/trace。
  const file = bodyRows[1]!.findAll('td')
  expect(file[4]!.text()).toBe('文件 12 · 第 3 页')
  expect(file[6]!.text()).toBe('不适用')
  expect(file[8]!.text()).toBe('—')
  const imported = bodyRows[2]!.findAll('td')
  expect(imported[4]!.text()).toBe('批次 batch-180 · 已处理 3/5 · 失败 1')
  expect(imported[5]!.text()).toBe('部分完成')
  expect(imported[6]!.text()).toBe('不适用')
  const client = bodyRows[3]!.findAll('td')
  expect(client[4]!.text()).toContain('客户端声称 original-180')
  expect(client[4]!.text()).toContain('UNTRUSTED')
  expect(client[6]!.text()).toBe('interaction')
  const oldTask = bodyRows[4]!.findAll('td')
  expect(oldTask[4]!.text()).toBe('任务 task-9')
  expect(oldTask[5]!.text()).toBe('结果未知')
  expect(oldTask[6]!.text()).toBe('不适用')
  expect(oldTask[7]!.text()).toBe('未记录')
  expect(oldTask[8]!.text()).toBe('—')
})

it('labels the 390px summary with a 44px detail target and lets long IDs wrap without escaping', async () => {
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const longestId = 'r' + 'q'.repeat(127)
  const longRoute = '/api/enterprises/:enterpriseId/records/:recordId/parts/:partId'
  const longErrorCode = 'operation_failed_' + 'x'.repeat(47)
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
      requestId: longestId,
      errorCode: longErrorCode
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
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  const items = wrapper.get('[data-testid=log-card-list]').findAll('li')
  expect(items).toHaveLength(2)
  const first = items[0]!
  for (const label of ['操作', '来源', '结果', '失败码', '目标', 'HTTP 状态', '耗时', '关联'])
    expect(first.text()).toContain(label)
  expect(first.text()).toContain('HTTP 接口')
  expect(first.text()).toContain('http')
  expect(first.text()).toContain('已拒绝')
  expect(first.text()).toContain(longRoute)
  expect(first.text()).toContain(longestId)
  // 390 的失败码是独立带标签行，长码可读且不挤进结果/耗时。
  const errorField = first.get('[data-log-field="errorCode"]')
  expect(errorField.text()).toContain('失败码')
  expect(errorField.text()).toContain(longErrorCode)
  expect(errorField.find('.font-mono.break-all').exists()).toBe(true)
  expect(first.findAll('.break-all').length).toBeGreaterThan(0)
  const detail = first.get('[data-log-detail]')
  expect(detail.text()).toBe('查看')
  expect(detail.classes()).toContain('min-h-11')
  expect(items[1]!.text()).toContain('文件 12 · 第 3 页')
  expect(items[1]!.text()).toContain('42 ms')
  expect(items[1]!.text()).toContain('失败码')
  expect(items[1]!.text()).toContain('不适用')
})

it('shows and copies the safe HTTP method and route template in the classified detail', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
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

it('keeps the current cursor page and drafts across log and configuration tabs without writing', async () => {
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const calls: { url: string; options: any }[] = []
  vi.stubGlobal('$fetch', async (url: string, options: any = {}) => {
    calls.push({ url, options })
    if (url === '/api/logs/policy') return policyView
    return { rows: [listRow(options.query.cursor ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001')], nextCursor: options.query.cursor ? null : 'next-2', status: { dropped: 0 } }
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs?source=ocr&outcome=partial')
  await router.isReady()
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.get('#log-source').text()).toContain('OCR 识别')
  expect(wrapper.get('#log-outcome').text()).toContain('部分完成')
  expect(wrapper.find('#log-retention-days').exists()).toBe(false)
  await wrapper.get('[aria-label="第 2 页"]').trigger('click')
  await flushPromises()
  expect(calls.filter(c => c.url === '/api/logs').at(-1)!.options.query.cursor).toBe('next-2')
  await wrapper.get('#log-operation').setValue('draft.operation')
  const reads = calls.filter(c => c.url === '/api/logs').length
  await wrapper.findAll('[role=tab]').find(t => t.text() === '日志配置')!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(router.currentRoute.value.query).toMatchObject({ tab: 'settings', source: 'ocr', outcome: 'partial' })
  await wrapper.get('#log-retention-days').setValue('8')
  await openModule(wrapper, 'source', 'http')
  await domGet('log-source-http-enabled').trigger('click')
  await closeModule(wrapper, 'source', 'http')
  await wrapper.findAll('[role=tab]').find(t => t.text() === '运行日志')!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(wrapper.get('[data-testid=table-pagination]').text()).toContain('第 2 页')
  expect((wrapper.get('#log-operation').element as HTMLInputElement).value).toBe('draft.operation')
  expect(calls.filter(c => c.url === '/api/logs')).toHaveLength(reads)
  await wrapper.findAll('[role=tab]').find(t => t.text() === '日志配置')!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect((wrapper.get('#log-retention-days').element as HTMLInputElement).value).toBe('8')
  await openModule(wrapper, 'source', 'http')
  expect(domGet('log-source-http-enabled').attributes('aria-checked')).toBe('false')
  expect(calls.filter(c => c.options.method && c.options.method !== 'GET')).toHaveLength(0)
})

it('shows MCP self-report only in the MCP section and keeps unrelated source fields out', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const uploadId = '0123456789abcdef0123456789abcdef'
  const event = {
    id: '00000000-0000-4000-8000-000000000401',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'mcp',
    operation: 'mcp.request',
    outcome: 'success',
    httpMethod: 'POST',
    httpRoute: '/mcp',
    statusCode: 200,
    mcp: {
      transport: 'streamable-http',
      sessionMode: 'stateless',
      rpcMethod: 'initialize',
      client: { name: 'cursor', version: '0.49.1', trust: 'self-reported', capturedAt: 'initialize' },
      protocolVersionRequested: '2025-06-18'
    }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('MCP 调用')
  expect(wrapper.text()).toContain('客户端类别（自报）')
  expect(wrapper.text()).toContain('Cursor')
  expect(wrapper.text()).toContain('协议版本（初始化请求声明）')
  expect(wrapper.text()).toContain('2025-06-18')
  expect(wrapper.text()).toContain('不是鉴权身份')
  expect(wrapper.text()).not.toContain('文件编号')
  expect(wrapper.text()).not.toContain('页码')
  expect(wrapper.text()).not.toContain('批次标识')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0]).mcp).toMatchObject({
    rpcMethod: 'initialize',
    client: { name: 'cursor', version: '0.49.1', trust: 'self-reported' }
  })
  expect(JSON.stringify(JSON.parse(writeText.mock.calls[0]![0]))).not.toContain(uploadId)
})

it('marks a writer-disabled field as 当时未启用采集 and keeps historical gaps unknown', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  // The writer recorded httpRoute/statusCode as disabled at capture time, revision 4.
  const captured = {
    id: '00000000-0000-4000-8000-000000000601',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'error',
    source: 'http',
    operation: 'http.request',
    outcome: 'failure',
    httpMethod: 'GET',
    durationMs: 12,
    errorCode: 'upstream_failed',
    counts: { failed: 0, done: 0 },
    fieldCapture: { profile: 'http', revision: 4, disabled: ['httpRoute', 'statusCode'] }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(captured))
  const wrapper = mount(Detail, { props: { id: captured.id } })
  wrappers.push(wrapper)
  await flushPromises()
  const text = wrapper.text()
  expect(text).toContain('当时未启用采集')
  expect(text).toContain('当时写入这条记录时未启用采集')
  expect(text).toContain('不追溯历史')
  // 不能说成框架未匹配路由或源头没提供；真实方法、耗时、失败码与 0 计数照常呈现。
  expect(text).not.toContain('框架未匹配到已知路由模板')
  expect(text).not.toContain('源头')
  expect(text).toContain('GET')
  expect(text).toContain('耗时（毫秒）')
  expect(text).toContain('upstream_failed')
  expect(text).toContain('失败 0')
  const disabledCells = wrapper.findAll('[data-omission=disabled]')
  expect(disabledCells).toHaveLength(2)
  for (const cell of disabledCells) expect(cell.text()).toBe('当时未启用采集')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({
    id: captured.id,
    timestamp: captured.timestamp,
    httpMethod: 'GET',
    durationMs: 12,
    errorCode: 'upstream_failed',
    fieldCapture: { profile: 'http', revision: 4, disabled: ['httpRoute', 'statusCode'] }
  })
  vi.unstubAllGlobals()
})

it('keeps a historical row without capture as 未记录 and never infers from current policy', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const historical = {
    id: '00000000-0000-4000-8000-000000000602',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'http',
    operation: 'http.request',
    outcome: 'success'
  }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(historical))
  const wrapper = mount(Detail, { props: { id: historical.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('未记录')
  expect(wrapper.text()).not.toContain('当时未启用采集')
  expect(wrapper.findAll('[data-omission=disabled]')).toHaveLength(0)
  // 旧记录的缺口仍按原来未知文案解释，不用当前策略倒推。
  expect(wrapper.text()).toContain('框架未匹配到已知路由模板')
  // 基础字段保持干净：没有无关的 fileId/page/batchId 行。
  expect(wrapper.text()).not.toContain('文件编号')
  expect(wrapper.text()).not.toContain('页码')
  vi.unstubAllGlobals()
})

it('rebuilds the copied capture from a fixed whitelist instead of trusting the response', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const base = {
    id: '00000000-0000-4000-8000-000000000603',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'warn',
    source: 'http',
    operation: 'http.request',
    outcome: 'denied',
    httpMethod: 'POST'
  }
  let event: any = {
    ...base,
    fieldCapture: {
      profile: 'http',
      revision: 7,
      disabled: ['httpRoute', 'statusCode', 'PRIVATE_FIELD', 'httpMethod'],
      privateToken: 'PRIVATE_CAPTURE'
    }
  }
  vi.stubGlobal('$fetch', vi.fn(async () => event))
  const wrapper = mount(Detail, { props: { id: base.id } })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const copied = JSON.parse(writeText.mock.calls[0]![0])
  // 任意键被丢掉，只保留已实现 profile 的已知字段名。
  expect(copied.fieldCapture).toEqual({
    profile: 'http',
    revision: 7,
    disabled: ['httpRoute', 'statusCode']
  })
  expect(JSON.stringify(copied)).not.toContain('PRIVATE')
  // 复制保留原始 id/time，不走 safeLogEvent 重新生成。
  expect(copied.id).toBe(base.id)
  expect(copied.timestamp).toBe(base.timestamp)
  const hostileCaptures = [
    { profile: 'tus', revision: 1, disabled: ['method'] },
    { profile: 'http', revision: Number.NaN, disabled: ['httpRoute'] },
    { profile: 'http', revision: -1, disabled: ['httpRoute'] },
    { profile: 'http', revision: 1.5, disabled: ['httpRoute'] },
    { profile: 'http', revision: 1, disabled: 'httpRoute' },
    { profile: 'http', revision: 1, disabled: [] },
    // 声明关闭但事件里其实有值：自相矛盾，不当成省略复制出去。
    { profile: 'http', revision: 1, disabled: ['httpMethod'] }
  ]
  for (const [index, hostile] of hostileCaptures.entries()) {
    const id = `00000000-0000-4000-8000-0000000007${String(index).padStart(2, '0')}`
    event = { ...base, id, fieldCapture: hostile }
    await wrapper.setProps({ id })
    await flushPromises()
    writeText.mockClear()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(JSON.parse(writeText.mock.calls[0]![0])).not.toHaveProperty('fieldCapture')
  }
  vi.unstubAllGlobals()
})

it('accepts an output-shaped TUS context with an omitted uploadId and keeps phase', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  // Output side (future FieldCapturedLogEvent) allows uploadId to be omitted while
  // phase stays required. The UI must not assume the stricter input shape.
  const event: any = {
    id: '00000000-0000-4000-8000-000000000604',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'warn',
    source: 'file',
    operation: 'file.upload',
    outcome: 'failure',
    tus: { phase: 'request-failed', method: 'PATCH' }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('上传（TUS）')
  expect(wrapper.text()).toContain('请求失败')
  // 没有 uploadId 不阻止复制剩余真实上下文；也不凭空补一个标识。
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const copied = JSON.parse(writeText.mock.calls[0]![0])
  expect(copied.tus).toEqual({ phase: 'request-failed', method: 'PATCH' })
  expect(copied.id).toBe(event.id)
  expect(copied.timestamp).toBe(event.timestamp)
  vi.unstubAllGlobals()
})

it('drops a capture whose profile this build has not implemented', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const event = {
    id: '00000000-0000-4000-8000-000000000605',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'worker',
    operation: 'worker.enterprise_read.finished',
    outcome: 'success',
    // Not one of the implemented profiles: must not be echoed as trusted copy.
    fieldCapture: { profile: 'worker', revision: 1, disabled: ['resourceId'] }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const copied = JSON.parse(writeText.mock.calls[0]![0])
  expect(copied).not.toHaveProperty('fieldCapture')
  expect(copied.id).toBe(event.id)
  vi.unstubAllGlobals()
})

it('keeps phase and the tus capture when uploadId was disabled at capture time', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  // Real writer output: tus.uploadId disabled in configuration, so the projected
  // context keeps phase/method but has no uploadId, and capture records why.
  const event: FieldCapturedLogEvent = {
    id: '00000000-0000-4000-8000-000000000606',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'warn',
    source: 'file',
    operation: 'file.upload',
    outcome: 'failure',
    tus: { phase: 'request-failed', method: 'PATCH', size: 2048, offset: 1024 },
    fieldCapture: { profile: 'tus', revision: 6, disabled: ['tus.uploadId'] }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  const text = wrapper.text()
  expect(text).toContain('上传（TUS）')
  expect(text).toContain('请求失败')
  expect(text).toContain('当时未启用采集')
  // uploadId 关闭不改变 phase，也不宣称源头没提供。
  expect(text).not.toContain('uploadId 来自服务端 tus 回调')
  const uploadCell = wrapper.get('[data-omission=disabled]')
  expect(uploadCell.text()).toBe('当时未启用采集')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const copied = JSON.parse(writeText.mock.calls[0]![0])
  expect(copied.tus).toEqual({ phase: 'request-failed', method: 'PATCH', size: 2048, offset: 1024 })
  expect(copied.fieldCapture).toEqual({ profile: 'tus', revision: 6, disabled: ['tus.uploadId'] })
  expect(copied.id).toBe(event.id)
  expect(copied.timestamp).toBe(event.timestamp)
  vi.unstubAllGlobals()
})

it('shows a dedicated TUS upload detail without pretending fileId/page are registered', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const uploadId = '0123456789abcdef0123456789abcdef'
  const event = {
    id: '00000000-0000-4000-8000-000000000402',
    timestamp: '2026-10-22T00:00:00Z',
    level: 'info',
    source: 'file',
    operation: 'file.upload',
    outcome: 'success',
    statusCode: 204,
    tus: { uploadId, phase: 'completed', method: 'PATCH', size: 2048, offset: 2048 }
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('上传（TUS）')
  expect(wrapper.text()).toContain('上传标识')
  expect(wrapper.text()).toContain(uploadId)
  expect(wrapper.text()).toContain('声明总量（字节）')
  expect(wrapper.text()).toContain('2048 字节')
  expect(wrapper.text()).not.toContain('文件编号')
  expect(wrapper.text()).not.toContain('页码')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(JSON.parse(writeText.mock.calls[0]![0]).tus).toEqual(event.tus)
})

// 以下聚焦“查询尝试汇总”与“写入结果未知”的计数含义；仍是组件级断言，不是浏览器证据。
const drizzleAttempt = (counts?: LogSummary['counts']): LogSummary =>
  makeLogRow({
    source: 'system',
    operation: 'db.query.select',
    level: 'debug',
    outcome: 'started',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
    resourceType: 'database_connection',
    resourceId: 'primary',
    ...(counts ? { counts } : {})
  })

it('keeps ordinary counts unchanged and reads only confirmed Drizzle attempts as query attempts', async () => {
  const { formatCounts, describeLogRow, queryAttemptTotal } = await import(
    '../../../components/logs/logPresentation'
  )
  // 普通来源的处理数量保持不变：默认不传标记时绝不出现“查询尝试”。
  expect(formatCounts({ done: 2, total: 3, failed: 1 })).toBe('已处理 2/3 · 失败 1')
  expect(formatCounts({ total: 4 })).toBe('共 4')
  expect(formatCounts({ total: 4 }, 'db.query.select')).toBe('共 4')
  expect(formatCounts({ total: 1 })).not.toContain('查询尝试')
  const taskRow = makeLogRow({ source: 'task', operation: 'task.finished', taskId: 't-1', counts: { total: 4 } })
  expect(describeLogRow(taskRow).target.text).toBe('任务 t-1 · 共 4')
  expect(describeLogRow(taskRow).target.text).not.toContain('查询尝试')
  const systemCounts = makeLogRow({ source: 'system', operation: 'logging.clear', counts: { total: 4 } })
  expect(describeLogRow(systemCounts).target.text).toBe('共 4')
  // 只有确认的 Drizzle 执行前钩子 + 正安全整数 total 才按“查询尝试 × N”展示。
  expect(queryAttemptTotal(drizzleAttempt({ total: 3 }))).toBe(3)
  expect(describeLogRow(drizzleAttempt({ total: 3 })).target.text).toBe('主业务库（primary） · 查询尝试 × 3')
  expect(describeLogRow(drizzleAttempt({ total: 1 })).target.text).toBe('主业务库（primary） · 查询尝试 × 1')
  expect(describeLogRow(drizzleAttempt({ total: 3 })).target.text).not.toContain('已处理')
  expect(describeLogRow(drizzleAttempt({ total: 3 })).target.text).not.toContain('成功')
  expect(formatCounts({ total: 3 }, 'db.query.select', true)).toBe('查询尝试 × 3')
  // 没有 counts 的历史查询、零/非法计数，或形状不完整的同名事件都不冒充汇总。
  expect(queryAttemptTotal(drizzleAttempt())).toBeUndefined()
  expect(queryAttemptTotal(drizzleAttempt({ total: 0 }))).toBeUndefined()
  expect(queryAttemptTotal(drizzleAttempt({ total: 1.5 }))).toBeUndefined()
  expect(queryAttemptTotal(drizzleAttempt({ total: 3, done: 1 }))).toBeUndefined()
  expect(formatCounts({ total: 0 }, 'db.query.select', true)).toBe('共 0')
  expect(
    queryAttemptTotal(makeLogRow({ source: 'system', operation: 'db.query.select', counts: { total: 3 } }))
  ).toBeUndefined()
  expect(
    queryAttemptTotal(makeLogRow({
      source: 'system',
      operation: 'db.query.select',
      level: 'info',
      outcome: 'started',
      origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
      resourceType: 'database_connection',
      resourceId: 'primary',
      counts: { total: 3 }
    }))
  ).toBeUndefined()
})

it('labels a Drizzle summary as query attempt count with a one-line explanation in the detail', async () => {
  const { default: Detail } = await import('../../../components/logs/LogDetail.vue')
  const event = {
    id: '00000000-0000-4000-8000-000000000801',
    timestamp: '2026-10-24T09:00:00Z',
    level: 'debug',
    source: 'system',
    operation: 'db.query.select',
    outcome: 'started',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
    resourceType: 'database_connection',
    resourceId: 'primary',
    counts: { total: 42 }
  }
  const legacyId = '00000000-0000-4000-8000-000000000802'
  vi.stubGlobal('$fetch', vi.fn(async (url: string) =>
    url.endsWith(legacyId) ? { ...event, id: legacyId, counts: undefined } : event
  ))
  const wrapper = mount(Detail, { props: { id: event.id } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('查询尝试次数')
  expect(wrapper.text()).toContain('查询尝试 × 42')
  expect(wrapper.text()).not.toContain('已处理 42')
  expect(wrapper.get('[data-testid=log-query-attempt-note]').text()).toBe(
    '排队期间查询尝试汇总，时间为首次尝试；不表示执行成功。'
  )
  // 说明只在详情底部一行，不新增区块。
  expect(wrapper.findAll('[data-testid=log-query-attempt-note]')).toHaveLength(1)
  // 历史 Drizzle 查询没有 counts：不显示汇总标签、数值或说明。
  await wrapper.setProps({ id: legacyId })
  await flushPromises()
  expect(wrapper.find('[data-testid=log-query-attempt-note]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('查询尝试次数')
  expect(wrapper.text()).not.toContain('查询尝试 ×')
  vi.unstubAllGlobals()
})

it('shows writeUnknown separately from dropped and reports coalesced without calling it lost or stored', async () => {
  const { default: Management } = await import('../../../components/logs/LogManagement.vue')
  let view: any = {
    ...policyResponse(),
    status: {
      dropped: 0,
      writeUnknown: 3,
      coalesced: 1200,
      unavailable: false,
      queuedEntries: 0,
      inFlightEntries: 0,
      since: '2026-10-22T00:00:00.000Z'
    }
  }
  vi.stubGlobal('$fetch', async () => view)
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  const status = wrapper.text()
  expect(status).toContain('已丢弃 0 条')
  expect(status).toContain('写入结果未知 3 条')
  expect(status).toContain('合并重复查询 1200 次')
  // 合并只按额外尝试计数，不称丢弃或存储成功。
  expect(status).not.toContain('合并重复查询 1200 条')
  expect(status).not.toContain('合并丢弃')
  expect(status).not.toContain('合并存储')
  // 没有异常时保持原来的常驻说明，不额外新增常驻长说明。
  expect(status).not.toContain('日志缺失不代表业务未执行')
  // 计数为 0（或旧后端不返回）时这两项不出现，不增加常驻说明。
  view = {
    ...policyResponse(),
    status: { dropped: 0, writeUnknown: 0, coalesced: 0, unavailable: false, since: '2026-10-22T00:00:00.000Z' }
  }
  const quiet = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(quiet)
  await flushPromises()
  expect(quiet.text()).not.toContain('写入结果未知')
  expect(quiet.text()).not.toContain('合并重复查询')
  expect(quiet.text()).not.toContain('日志缺失不代表业务未执行')
  vi.unstubAllGlobals()
})

it('keeps the list status strip showing unknown writes and the missing-log caveat after storage recovers', async () => {
  const { default: Page } = await import('../../../pages/logs.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  let status: any = { dropped: 0, writeUnknown: 2, unavailable: false }
  vi.stubGlobal('$fetch', async (url: string) => {
    if (url === '/api/logs/policy') return policyView
    return { rows: [listRow('00000000-0000-4000-8000-000000000901')], nextCursor: null, status }
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/logs', component: Page }] })
  await router.push('/logs')
  await router.isReady()
  const wrapper = mount(Page, {
    global: { plugins: [router], stubs: { Icon: IconStub } },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  await flushPromises()
  const text = wrapper.text()
  expect(text).toContain('日志存储可用')
  expect(text).toContain('本进程已丢弃 0 条')
  expect(text).toContain('写入结果未知 2 条')
  // 存储已恢复但仍有无法确认的记录：异常口径保留，不因 unavailable=false 消失。
  expect(text).toContain('日志缺失不代表业务未执行')
  status = { dropped: 0, writeUnknown: 0, unavailable: false }
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain('写入结果未知')
  expect(wrapper.text()).not.toContain('日志缺失不代表业务未执行')
  // 旧后端不返回 writeUnknown 时按 0 读，不补造未知计数。
  status = { dropped: 0, unavailable: false }
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain('写入结果未知')
  vi.unstubAllGlobals()
})

it('navigates both log time calendars without applying and submits chosen month ends', async () => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
  const { default: Filters } = await import('../../../components/logs/LogFilters.vue')
  const wrapper = mount(Filters, { props: { filter: { from: '2026-10-18T10:04:05Z', to: '2026-10-19T11:06:07Z' } }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  for (const [id, year, month, day] of [['log-from', '2024', '2', '2024-02-29'], ['log-to', '2024', '4', '2024-04-30']]) {
    await wrapper.get(`#${id}`).trigger('click'); await flushPromises()
    await chooseCalendarSelect('年份', year!)
    await chooseCalendarSelect('月份', month!)
    expect(wrapper.emitted('apply')).toBeUndefined()
    document.querySelector<HTMLElement>(`[data-value="${day}"]`)!.click(); await flushPromises()
    ;[...document.querySelectorAll('button')].find(button => button.textContent === '完成')!.click(); await flushPromises()
  }
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('apply')?.at(-1)).toEqual([{ from: '2024-02-29T10:04:05.000Z', to: '2024-04-30T11:06:07.000Z' }])
  vi.unstubAllEnvs()
})
