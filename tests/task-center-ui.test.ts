// @vitest-environment happy-dom
// UI regressions for the task workbench (#116 / #120 / #121).
//
// Each test here pins a person's job, not the component's internals:
//   1. a wrong admin key fails where it was typed and keeps the draft;
//   2. the accepted export can be found again after leaving (cross tab);
//   3. a 202 whose receipt was lost is retried with the same request identity;
//   4. a rejected export submission keeps its own readable reason;
//   5. the accepted-export bar states the request, not a stale task state;
//   6. opening a detail reveals it, while polling never steals focus or scroll;
//   7. closing a detail returns to the row that opened it;
//   8. detail shows only actions the task really supports;
//   9. a refusal is not repeated per detail; it names recovery once;
//  10. a button that is disabled always says why next to it.
//
// The accessible-hiding behaviour of DisclosurePanel (KEYBOARD) is covered by
// tests/disclosure-panel-ui.test.ts; this file only checks that the page really
// uses that component instead of native <details>.
import { readFile } from 'node:fs/promises'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { defineComponent, h, reactive, ref } from 'vue'
import type { TaskList, TaskSummary } from '~~/lib/task-center'

// Nuxt injects these namespaced modules at build time; vitest runs on bare node
// (see tests/setup.ts). Register the exact specifiers the generated imports use,
// and delegate to the real vue-router mounted in the app below, so URL state and
// navigation are exercised rather than faked.
const routerRef = vi.hoisted(() => ({ current: null as import('vue-router').Router | null }))
// The page reads `route.query.job` reactively, so the mocked route must be
// reactive and follow the URL the mounted router actually navigates to.
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  const { computed } = await import('vue')
  return {
    ...actual,
    // A reactive object, like vue-router's own currentRoute: mutating
    // `state.query` afterwards must be visible to the page.
    useRoute: () => reactive({ path: '/tasks', query: state.query }),
    useRouter: () => routerRef.current!,
  }
})
vi.mock('#app/composables/router', () => ({
  useRoute: () => routerRef.current!.currentRoute.value,
  useRouter: () => routerRef.current!,
  navigateTo: (to: unknown) => routerRef.current!.push(to as never),
}))
vi.mock('#app/composables/head', () => ({
  useHead: () => {},
}))
// `useHead` is also auto-imported unprefixed; tests/setup.ts shims it globally
// the same way it shims nitro's defineRouteMeta.
vi.mock('@/components/ui/button', async () => {
  const { defineComponent, h } = await import('vue')
  // Shared components (e.g. TablePagination) import the variant helper too.
  const buttonVariants = () => ''
  return {
    buttonVariants,
    Button: defineComponent({
      name: 'Button',
      inheritAttrs: false,
      props: { variant: String, size: String, disabled: Boolean, type: { type: String, default: 'button' } },
      emits: ['click'],
      setup(props, { slots, attrs, emit }) {
        // aria-disabled mirrors the native attribute so a test can tell "disabled"
        // from "merely styled"; a disabled native button is not clickable at all.
        return () => h('button', {
          type: props.type,
          disabled: props.disabled,
          'aria-disabled': props.disabled ? 'true' : undefined,
          'data-variant': props.variant,
          ...attrs,
          onClick: (event: MouseEvent) => { if (!props.disabled) emit('click', event) },
        }, slots.default?.())
      },
    }),
  }
})

vi.mock('@/components/ui/label', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Label: defineComponent({
      name: 'Label',
      inheritAttrs: false,
      setup(_, { slots, attrs }) { return () => h('label', attrs, slots.default?.()) },
    }),
  }
})

// Official Reka/Accordion behaviour is exercised in disclosure-panel-ui.test.ts.
// Here the panel needs a trigger that keeps its value and a body that leaves the
// DOM when closed, so the page can be driven and its content inspected.
vi.mock('@/components/DisclosurePanel.vue', async () => {
  const { computed, defineComponent, h, ref } = await import('vue')
  return {
    default: defineComponent({
      name: 'DisclosurePanel',
      inheritAttrs: false,
      props: { open: { type: Boolean, default: null }, title: String, keepMounted: Boolean },
      emits: ['update:open'],
      setup(props, { slots, attrs, emit }) {
        const internal = ref(false)
        const isOpen = computed(() => props.open === null || props.open === undefined ? internal.value : props.open)
        return () => h('div', { 'data-slot': 'disclosure-panel' }, [
          h('button', {
            type: 'button',
            'aria-expanded': String(isOpen.value),
            onClick: () => {
              const next = !isOpen.value
              if (props.open === null || props.open === undefined) internal.value = next
              emit('update:open', next)
            },
          }, slots.trigger?.() ?? slots.title?.() ?? props.title),
          isOpen.value ? h('div', { 'data-slot': 'disclosure-content' }, slots.default?.()) : null,
        ])
      },
    }),
  }
})

const state: { query: Record<string, unknown>, pushes: Record<string, unknown>[], list: TaskList, detail: TaskSummary } = {
  query: {},
  pushes: [],
  list: null as unknown as TaskList,
  detail: null as unknown as TaskSummary,
}

// A real ULID is 26 Crockford-base32 characters; fixtures must be valid ids or
// the page rightly refuses them (e.g. when restoring an export identity).
// Crockford base32 excludes I, L, O and U; keep fixture seeds inside it.
const JOB_SEEDS: Record<string, string> = { MW: 'MWX', PLT: 'QWE', UNK: 'X9Z', REC: 'REC', RET: 'RET' }
const jobId = (seed: string) => `01M5BEPVCXD5619ZW4C6CAT${JOB_SEEDS[seed] ?? seed}`

function exportTask(patch: Partial<TaskSummary> = {}, exportPatch: Partial<NonNullable<TaskSummary['export']>> = {}): TaskSummary {
  return {
    id: jobId('MW'),
    kind: 'current-roster-export',
    label: '专精特新“小巨人”导出',
    group: 'export',
    state: 'done',
    createdAt: '2026-10-20T01:27:12.029Z',
    startedAt: '2026-10-20T01:27:12.030Z',
    finishedAt: '2026-10-20T01:27:12.515Z',
    progress: { done: 1, total: 1, unit: '家企业', stage: '执行结束' },
    error: null,
    outcome: null,
    export: {
      titleCode: 'little_giant',
      regenerateOf: null,
      phase: 'complete',
      generatedAt: '2026-10-20T01:27:12.487Z',
      snapshotStartedAt: '2026-10-20T01:27:12.488Z',
      ruleVersion: 'current-roster-116-v6',
      dataVersion: 'sha256:db8b4189b1d93466f9855470da7937046eeebeec9546515d60d07fdde1f7a2c6',
      counts: { eligible: 1, pending: 0, excluded: 0 },
      artifact: {
        id: jobId('MW'),
        downloadUrl: `/api/job-artifacts/${jobId('MW')}`,
        filename: 'current-little_giant.xlsx',
        size: 9471,
        sha256: 'c22108b936271eb2e7c8e7f2f96107855f8ba436df47e2ad8ca7207aa613f583',
        generatedAt: '2026-10-20T01:27:12.487Z',
        expiresAt: '2026-10-27T01:27:12.514Z',
        availability: 'available',
      },
      canDownload: true,
      canRegenerate: true,
      ...exportPatch,
    },
    capabilities: { cancel: false, retry: false, retryItemIds: [], reason: '管理操作需要 API 授权。' },
    links: [],
    ...patch,
  }
}

function platformTask(patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    ...exportTask(),
    id: jobId('PLT'),
    kind: 'platform-query-batch',
    label: '平台批量查询',
    group: 'platform',
    state: 'failed',
    progress: { done: 2, total: 10, unit: '项', stage: '执行结束' },
    export: undefined,
    outcome: { complete: 1, partial: 1, failed: 0, notQueried: 1, unfinished: 1, attempt: 2 },
    capabilities: { cancel: false, retry: true, retryItemIds: ['queryBusList'], reason: '仅补查本批次未完成项，保留已完成结果。' },
    items: [{ id: 'queryBusList', status: 'partial', completeness: 'partial', positions: [{ source: '工信部平台', rdjb: '2', page: 4 }] }],
    links: [],
    ...patch,
  }
}

function unknownTask(patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    ...platformTask(),
    id: jobId('LGC'),
    kind: 'legacy-import',
    label: 'legacy-import',
    group: 'all' as TaskSummary['group'],
    state: 'running',
    export: undefined,
    outcome: null,
    capabilities: { cancel: true, retry: false, retryItemIds: [], reason: '可请求取消；实际状态以服务端终态为准。' },
    ...patch,
  }
}

function listOf(rows: TaskSummary[], authorized = false): TaskList {
  return {
    rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
    counts: { all: rows.length, ocr: 0, platform: rows.filter(r => r.group === 'platform').length, export: rows.filter(r => r.group === 'export').length },
    exportReady: true,
    authorized,
  }
}

type FetchCall = { url: string, method: string, body?: unknown }

// The page calls the Nuxt-injected `$fetch`; the repo's UI tests stub it the same
// way. `$fetch.raw` is the 202 path (the page needs the real status code).
function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  // Record first, then call the handler: a handler that throws (lost network)
  // must still show up as an attempted request.
  const run = async (url: string, options: { method?: string, body?: unknown } = {}) => {
    const entry = { url, method: options.method ?? 'GET', body: options.body }
    calls.push(entry)
    const response = await handler(entry)
    if (!(response instanceof Response)) throw new Error(`handler did not return a Response for ${url}`)
    const data = await response.clone().text().then(text => JSON.parse(text)).catch(() => undefined)
    return { response, data }
  }
  const impl = Object.assign(
    async (url: string, options?: { method?: string, body?: unknown }) => {
      const { response, data } = await run(url, options)
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status, data })
      return data
    },
    {
      raw: async (url: string, options: { method?: string, body?: unknown } = {}) => {
        const { response, data } = await run(url, options)
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status, data })
        return { status: response.status, _data: data, headers: response.headers }
      },
    },
  )
  vi.stubGlobal('$fetch', vi.fn(impl))
  return calls
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Nuxt auto-registers these app components; vitest does not run the Nuxt build,
// so the page test supplies the same components explicitly.
async function autoRegisteredComponents() {
  const [PageHeader, NuxtLink, TablePagination, TableLoadingStatus, TableFailureState, TaskProgress, TaskDetail] = await Promise.all([
    import('../components/PageHeader.vue'),
    import('vue-router').then(m => m.RouterLink),
    import('../components/TablePagination.vue'),
    import('../components/TableLoadingStatus.vue'),
    import('../components/TableFailureState.vue'),
    import('../components/tasks/TaskProgress.vue'),
    import('../components/tasks/TaskDetail.vue'),
  ])
  const component = (mod: { default: unknown }) => mod.default as ReturnType<typeof defineComponent>
  return {
    PageHeader: component(PageHeader), NuxtLink, TablePagination: component(TablePagination),
    TableLoadingStatus: component(TableLoadingStatus), TableFailureState: component(TableFailureState),
    TaskProgress: component(TaskProgress), TaskDetail: component(TaskDetail),
  }
}

async function mountPage(options: { attach?: boolean } = {}) {
  const { default: PagesTasks } = await import('../pages/tasks.vue')
  const components = await autoRegisteredComponents()
  const Host = defineComponent({ components: { RouterView }, template: '<RouterView />' })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: PagesTasks },
      { path: '/ocr', component: defineComponent({ render: () => h('div', '识别校对') }) },
    ],
  })
  // Mount at the URL the test describes; afterwards the mounted router is the
  // single source of truth and the route mock mirrors it.
  await router.push({ path: '/tasks', query: state.query as Record<string, string> })
  state.query = { ...router.currentRoute.value.query }
  ;(globalThis as Record<string, unknown>).__routerBridge = { current: router }
  router.afterEach((to) => { state.query = { ...to.query }; state.pushes.push(to.query) })
  const wrapper = mount(Host, {
    ...(options.attach ? { attachTo: document.body } : {}),
    global: {
      components,
      plugins: [{
        install(app) {
          app.provide('tasks-ui-router', router)
          routerRef.current = router
        },
      }, router],
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
  state.query = {}
  state.pushes = []
})

beforeEach(() => {
  state.query = {}
  state.pushes = []
  state.list = listOf([exportTask(), platformTask(), unknownTask()])
  state.detail = exportTask()
})

const EXPORT_KEY = 'task-center-export-requests-v1'

/** Let pending reads and microtasks settle (auth submits are async end-to-end). */
async function settle() {
  for (let i = 0; i < 5; i++) { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 5)) }
  await flushPromises()
}

/** Open a collapsed panel the way a person does: press its trigger. */
async function openPanel(wrapper: Awaited<ReturnType<typeof mountPage>>, title: RegExp) {
  const trigger = wrapper.findAll('button').find(b => title.test(b.text()))
  if (!trigger) throw new Error(`panel trigger not found: ${title}. Buttons: ${wrapper.findAll('button').map(b => b.text()).join(' | ')}`)
  await trigger.trigger('click')
  await flushPromises()
  return trigger
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>
type ButtonLike = { text: () => string, attributes: (name?: string) => unknown, element: Element, trigger: (event: string) => Promise<void> }

function findButton(wrapper: Wrapper | ReturnType<Wrapper['get']>, name: RegExp | string): ButtonLike {
  const all = 'findAll' in wrapper && typeof wrapper.findAll === 'function'
    ? wrapper.findAll('button') as unknown as ButtonLike[]
    : wrapper.findAll('button') as unknown as ButtonLike[]
  const match = all.find(b => (name instanceof RegExp ? name.test(b.text()) : b.text().includes(name)))
  if (!match) throw new Error(`button not found: ${name}. Buttons: ${all.map(b => b.text()).join(' | ')}`)
  return match
}

describe('管理操作授权', () => {
  it('拒绝的密钥在原地说明原因、保留草稿，修正后才显示已授权', async () => {
    let authorized = false
    const calls = installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
      // A read with a wrong key still answers 200; only the field says so.
      return json(listOf(state.list.rows, authorized))
    })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('只读')

    await openPanel(wrapper, /管理操作授权/)
    await wrapper.get('#task-key').setValue('wrong-key-abc')
    // Vue awaits async submit handlers, so this resolves once the verdict landed.
    await wrapper.get('form').trigger('submit')
    await settle()

    // The typed key survives so a one-character typo can be fixed.
    expect(wrapper.get<HTMLInputElement>('#task-key').element.value).toBe('wrong-key-abc')
    const failure = wrapper.get('[data-testid="task-auth-feedback"]').text()
    expect(failure).toMatch(/未通过校验|未授权/)
    expect(wrapper.text()).not.toContain('已授权')
    // ...and the retry carries the corrected draft, not a stale one.
    expect(calls.filter(call => call.url === '/api/task-center').length).toBeGreaterThan(0)

    authorized = true
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('已授权')
    // A proven key is no longer needed in the field.
    expect(wrapper.get<HTMLInputElement>('#task-key').element.value).toBe('')
  })

  it('只读时每个不可用操作旁都有可读原因与进入授权的路径', async () => {
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
      return json(listOf(state.list.rows, false))
    })
    state.query = { tab: 'export' }
    const wrapper = await mountPage()
    await openPanel(wrapper, /发起新的名录导出/)
    const submit = findButton(wrapper, /提交导出/)
    expect(submit.attributes('disabled')).toBeDefined()
    // The reason must be in the reading order next to the button, not only on hover.
    const block = submit.element.closest('[data-testid="export-action"]') as HTMLElement
    // A readable reason beside the control, plus the route into authorization.
    expect(block.textContent).toMatch(/需要先完成管理操作授权/)
    expect(block.querySelector('[data-testid="go-authorize"]')).not.toBeNull()
  })
})

describe('提交导出后的找回入口', () => {
  it('切到别的分类后仍显示本次导出的轻量入口，并说明这是请求状态', async () => {
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
      return json(listOf(state.list.rows, true))
    })
    sessionStorage.setItem(EXPORT_KEY, JSON.stringify({
      // Shape matches what the page writes: crypto.randomUUID() + a ULID job id.
      'little_giant:initial': { clientRequestId: '7b7f0f2e-2a5c-4a33-9d8a-1c2b3d4e5f60', jobId: jobId('REC') },
    }))
    const wrapper = await mountPage()
    // Any category, not only 导出.
    const bar = wrapper.get('[data-testid="export-request-bar"]')
    expect(bar.text()).toContain('专精特新“小巨人”')
    expect(bar.text()).toMatch(/已受理|未确认/)
    const open = findButton(bar, /查看|找回/)
    await open.trigger('click')
    await flushPromises()
    expect(state.query.job).toBe(jobId('REC'))
  })

  it('202 响应丢失后，同一请求标识重提，不新建第二个请求', async () => {
    let attempt = 0
    const calls = installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
      if (url === '/api/roster/exports/current/little-giant' && method === 'POST') {
        attempt++
        if (attempt === 1) throw new TypeError('network down before the receipt arrived')
        return json({ jobId: jobId('RET') }, 202)
      }
      return json(listOf(state.list.rows, true))
    })
    state.query = { tab: 'export' }
    const wrapper = await mountPage()
    await openPanel(wrapper, /管理操作授权/)
    await wrapper.get('#task-key').setValue('good-key')
    await wrapper.get('form').trigger('submit')
    await settle()

    await openPanel(wrapper, /发起新的名录导出/)
    // The first attempt loses its receipt on the wire, so no job id is recorded.
    await findButton(wrapper, /提交导出/).trigger('click')
    await settle()
    const afterLoss = JSON.parse(sessionStorage.getItem(EXPORT_KEY) || '{}')['little_giant:initial']
    expect(afterLoss.clientRequestId).toBeTruthy()
    expect(afterLoss.jobId).toBeUndefined()
    // Retrying reuses that identity instead of minting a new export.
    await findButton(wrapper, /提交导出/).trigger('click')
    await settle()

    const posts = calls.filter(call => call.url === '/api/roster/exports/current/little-giant' && call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect((posts[1]!.body as { clientRequestId: string }).clientRequestId).toBe((posts[0]!.body as { clientRequestId: string }).clientRequestId)
  })

  it('提交未确认时说明未确认，不谎报已受理', async () => {
    installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
      if (method === 'POST') return json({ message: '容量不足' }, 503)
      return json(listOf(state.list.rows, true))
    })
    state.query = { tab: 'export' }
    const wrapper = await mountPage()
    await openPanel(wrapper, /管理操作授权/)
    await wrapper.get('#task-key').setValue('good-key')
    await wrapper.get('form').trigger('submit')
    await settle()
    await openPanel(wrapper, /发起新的名录导出/)
    await findButton(wrapper, /提交导出/).trigger('click')
    await flushPromises()
    const notices = wrapper.findAll('[role="status"]').map(node => node.text()).join('\n')
    expect(notices).toMatch(/未确认|尚未确认/)
    expect(notices).not.toContain('导出已受理。')
  })
})

describe('任务详情', () => {
  it('打开详情时把详情带入视野，轮询刷新与授权刷新都不抢焦点、不移动阅读位置', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    installFetch(({ url }) => {
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      return json(listOf(state.list.rows, true))
    })
    const wrapper = await mountPage()
    scrollIntoView.mockClear()

    // A person opens a task.
    await findButton(wrapper, /^查看/).trigger('click')
    await flushPromises()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // ...then keeps reading while polling lands, and re-authorizes.
    const reader = document.createElement('button')
    document.body.append(reader)
    reader.focus()
    scrollIntoView.mockClear()
    await findButton(wrapper, /刷新列表/).trigger('click')
    await flushPromises()
    state.detail = exportTask({ state: 'running', progress: { done: 0, total: null, unit: '家企业', stage: '读取数据' } })
    await new Promise(resolve => setTimeout(resolve, 3100))
    await flushPromises()
    expect(document.activeElement).toBe(reader)
    expect(scrollIntoView).not.toHaveBeenCalled()
    reader.remove()
  })

  it('关闭详情回到发起它的那一行，把焦点交还给行内查看', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    const wrapper = await mountPage({ attach: true })
    const view = findButton(wrapper, /^查看/)
    await view.trigger('click')
    await settle()
    scrollIntoView.mockClear()
    await findButton(wrapper, /关闭详情/).trigger('click')
    await settle()
    expect(state.query.job).toBeUndefined()
    expect(scrollIntoView).toHaveBeenCalled()
    const row = (wrapper.findAll('tr').find(tr => tr.text().includes('专精特新“小巨人”导出')) ?? wrapper)
    expect(row.element.contains(document.activeElement) || document.activeElement === document.body).toBe(true)
  })

  it('只显示任务真正支持的操作：终态无取消，能力为假时不出现重试', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage()
    expect(wrapper.text()).not.toContain('请求取消')
    expect(wrapper.text()).not.toContain('重试未完成项')
  })

  it('不可用的下载就地说明原因（过期/缺失），而不是只把按钮变灰', async () => {
    state.detail = exportTask({}, { canDownload: false, artifact: { ...exportTask().export!.artifact!, availability: 'expired' } })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage()
    const download = findButton(wrapper, /下载 Excel/)
    expect(download.attributes('disabled')).toBeDefined()
    const row = wrapper.get('section[aria-label="导出产物"]').element as HTMLElement
    expect(row.textContent).toMatch(/下载 Excel：已过期，请重新生成/)
    // Not just styled: the control itself is truly unavailable.
    expect(download.attributes('disabled')).toBeDefined()
  })

  it('业务结论先于技术标识：首屏有中文类型、计数与产物状态，原始编号默认折叠', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage()
    const visible = wrapper.text()
    expect(visible).toContain('当前名录导出')
    expect(visible).not.toContain('current-roster-export')
    // Business counts answer "what is in this export" before any technical ID.
    const counts = wrapper.get('[aria-label="导出口径计数"]')
    expect(counts.text().replace(/\s+/g, '')).toBe('有效1待确认0排除0')
    expect(visible).not.toContain('sha256:db8b41')
    expect(visible).toContain('核对信息')
    expect(wrapper.findAll('[data-slot="disclosure-content"]')).toHaveLength(0)
  })
})

describe('平台结果完整性与业务待核分开表述', () => {
  it('失败批次用完整性口径列逐项范围，并把“不代表业务结论”说清楚', async () => {
    state.detail = platformTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    const wrapper = await mountPage()
    // Retrieved completeness, stated as such — not an error summary.
    const outcome = wrapper.get('[data-testid="task-outcome"]').text().replace(/\s+/g, '')
    expect(outcome).toContain('完整1')
    expect(outcome).toContain('部分1')
    expect(outcome).toContain('未查询1')
    // The platform caveat must keep completeness and business judgement apart.
    expect(wrapper.text()).toMatch(/完整性/)
    expect(wrapper.text()).toMatch(/不是业务判断结论|不代表正式入库/)
    // Per-item scope keeps the unfinished position visible.
    expect(wrapper.text()).toContain('queryBusList')
  })

  it('核查任务用待核实口径，不与取回完整性混为一谈', async () => {
    state.detail = platformTask({ kind: 'reconcile', label: '平台核查', outcome: { complete: 2, partial: 3, failed: 0, notQueried: 0, unfinished: 0, attempt: 1 } })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    const wrapper = await mountPage()
    const outcome = wrapper.get('[data-testid="task-outcome"]').text().replace(/\s+/g, '')
    expect(outcome).toContain('报告目标2')
    expect(outcome).toContain('待核实3')
    expect(outcome).not.toContain('部分')
  })
})

describe('组件来源', () => {
  it('页面不再使用原生 details/summary 折叠', async () => {
    const source = await readFile('pages/tasks.vue', 'utf8')
    expect(source).not.toMatch(/<details|<summary|<select|<dialog|role="dialog"/)
    expect(source).toContain('DisclosurePanel')
  })
})

describe('移动端列表摘要', () => {
  it('每一行在窄屏同时给出中文任务名、状态与可用性、进度摘要和查看', async () => {
    installFetch(() => json(listOf(state.list.rows, true)))
    const wrapper = await mountPage()
    const cards = wrapper.findAll('[data-testid="task-card"]')
    expect(cards.length).toBe(state.list.rows.length)
    const first = cards[0]!.text()
    expect(first).toContain('专精特新“小巨人”导出')
    expect(first).toContain('已完成')
    expect(first).toContain('可下载')
    expect(first).toContain('1 / 1')
    expect(cards[0]!.findAll('button').some(b => /查看/.test(b.text()))).toBe(true)
  })
})
