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
  await wrapper.get('[data-log-next]').trigger('click')
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
  expect(wrapper.get('[data-testid=table-failure-state]').text()).toContain('req-new')
  expect(wrapper.get('[data-testid=table-failure-state]').text()).toContain('保留上次结果（第 1 页')
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
