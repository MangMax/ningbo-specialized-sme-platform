// @vitest-environment happy-dom
// UI regressions for the task workbench (#116 / #120 / #121).
//
// The workbench uses same-origin browser requests: there is no admin key form,
// no credential in the browser, and every task request carries the browser
// marker header instead of a Bearer token. Each test here pins a person's job:
//
//   1. the page never asks for a key and never sends a credential;
//   2. each task's server capabilities decide whether an action is usable,
//      and an unusable action says why next to it;
//   3. a task opens in a real drawer (Reka Sheet) and the URL carries the job;
//   4. closing the drawer takes the job out of the URL and gives the caret back
//      to the row that opened it;
//   5. a refresh never re-mounts the detail, never steals the caret and never
//      moves the reading position;
//   6. the accepted export can be found again after leaving (cross tab);
//   7. a 202 whose receipt was lost is retried with the same request identity;
//   8. a rejected export submission keeps its own readable reason;
//   9. the accepted-export bar states the request, not a stale task state;
//  10. the detail shows only the actions the task really supports;
//  11. a button that is disabled always says why next to it.
//
// The drawer is a **real** Reka Sheet: it teleports into document.body, so the
// detail is read from `document`, not from the wrapper.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { defineComponent, h, reactive } from 'vue'
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

// Everything below is mounted with the repository's **real** components (the
// Reka Tabs/Select/Sheet, Button's `disabled`, DisclosurePanel's accordion).
// Only the dev-only theme toggle and the icon-only sidebar are left out: they
// have nothing to do with the task page's contracts.

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
    module: 'sme-roster',
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
    capabilities: { cancel: false, retry: false, retryItemIds: [], reason: '服务端未开放该任务的页面操作。' },
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
    module: null,
    group: 'all',
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
    counts: { all: rows.length, core: rows.filter(r => r.module === 'core').length, 'sme-roster': rows.filter(r => r.module === 'sme-roster').length },
    exportReady: true,
    authorized,
  }
}

type FetchCall = { url: string, method: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal }

// The page calls the Nuxt-injected `$fetch`; the repo's UI tests stub it the same
// way. `$fetch.raw` is the 202 path (the page needs the real status code).
function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  // Record first, then call the handler: a handler that throws (lost network)
  // must still show up as an attempted request.
  const run = async (url: string, options: { method?: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal } = {}) => {
    const entry = { url, method: options.method ?? 'GET', body: options.body, headers: options.headers, query: options.query, signal: options.signal }
    calls.push(entry)
    const response = await handler(entry)
    ;(options as { onResponse?: (context: { response: Response }) => void }).onResponse?.({ response })
    if (!(response instanceof Response)) throw new Error(`handler did not return a Response for ${url}`)
    const data = await response.clone().text().then(text => JSON.parse(text)).catch(() => undefined)
    return { response, data }
  }
  const impl = Object.assign(
    async (url: string, options?: { method?: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal }) => {
      const { response, data } = await run(url, options)
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status, data })
      return data
    },
    {
      raw: async (url: string, options: { method?: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal } = {}) => {
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
// so the page test supplies the same components explicitly. Select, Tabs,
// Button, Label, DisclosurePanel, Sheet and the UI primitives are deliberately
// **not** stubbed: their real behaviour (Reka focus movement, a drawer that
// teleports into document.body, disabled buttons that cannot be clicked) is part
// of what these tests are about.
async function autoRegisteredComponents() {
  const [PageHeader, NuxtLink, TablePagination, TableLoadingStatus, TableFailureState, TaskProgress, TaskDetail] = await Promise.all([
    import('../../../layers/core/app/components/PageHeader.vue'),
    import('vue-router').then(m => m.RouterLink),
    import('../../../layers/core/app/components/TablePagination.vue'),
    import('../../../layers/core/app/components/TableLoadingStatus.vue'),
    import('../../../layers/core/app/components/TableFailureState.vue'),
    import('../../../components/tasks/TaskProgress.vue'),
    import('../../../components/tasks/TaskDetail.vue'),
  ])
  const component = (mod: { default: unknown }) => mod.default as ReturnType<typeof defineComponent>
  return {
    PageHeader: component(PageHeader), NuxtLink, TablePagination: component(TablePagination),
    TableLoadingStatus: component(TableLoadingStatus), TableFailureState: component(TableFailureState),
    TaskProgress: component(TaskProgress), TaskDetail: component(TaskDetail),
  }
}

/** Every live button in the page that could take focus right now. */
function focusableButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.disabled && button.getClientRects().length > 0 && button.isConnected)
}

/** True when `button` is the row action of *this* task in a rendered row. */
function isRowActionFor(button: Element | null, id: string): boolean {
  const row = button?.closest<HTMLElement>('[data-task-row]')
  return !!row && row.dataset.taskRow === id && !!button?.hasAttribute('data-row-action') && button.getClientRects().length > 0
}

/** One rect per element; still empty when something in the ancestor chain is hidden. */
const shownRect = [{ width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10, x: 0, y: 0, toJSON: () => ({}) }] as unknown as DOMRectList
const hiddenRect = [] as unknown as DOMRectList

/**
 * happy-dom lays nothing out, so `getClientRects()` is empty for every element and
 * the page (rightly) treats them all as hidden. These stubs answer only the one
 * question the page asks — is this element on screen — never positions or sizes.
 *
 * - `layout('desktop')`: the `sm:block` table is rendered, the `sm:hidden` list is not.
 * - `layout('mobile')`: the reverse, as at 390px.
 * - `layout('hidden')`: nothing is rendered (the row is on another filter/page).
 */
function layout(mode: 'desktop' | 'mobile' | 'hidden') {
  const original = HTMLElement.prototype.getClientRects
  const shows = function (this: HTMLElement) {
    for (let node: HTMLElement | null = this; node; node = node.parentElement) {
      const hidden = node.classList.contains('hidden')
      const desktopOnly = node.classList.contains('sm:block')
      // The page's own visibility rule wins over the simulated width.
      if (hidden && !desktopOnly) return false
      if (mode === 'hidden' && (desktopOnly || node.classList.contains('sm:hidden'))) return false
      if (mode === 'desktop' && node.classList.contains('sm:hidden')) return false
      if (mode === 'mobile' && desktopOnly) return false
    }
    return true
  }
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) { return shows.call(this) ? shownRect : hiddenRect }
  return () => { HTMLElement.prototype.getClientRects = original }
}

/**
 * The scroll the page asked for.
 *
 * happy-dom has no layout, so "did the page move the reading position" is
 * answered through the call itself: the page must not scroll a detail that is
 * merely being refreshed.
 */
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
let scrollIntoViewCalls = 0
function trackScrolls() {
  scrollIntoViewCalls = 0
  HTMLElement.prototype.scrollIntoView = function () { scrollIntoViewCalls++ }
}
function restoreScrolls() {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
}

let pageModule: { default: ReturnType<typeof defineComponent> } | null = null
async function mountPage(options: { attach?: boolean, viewport?: 'desktop' | 'mobile' | 'hidden', freshPage?: boolean } = {}) {
  // Every page is attached while it is driven; a person leaves by unmounting it.
  options.attach = true
  restoreLayout.push(layout(options.viewport ?? 'desktop'))
  // The page's polling/watchers belong to the page instance; a module loaded once
  // is fine, but a test that remounts after "leaving" gets a fresh module too.
  if (!pageModule || options.freshPage) pageModule = await import('../../../pages/tasks.vue')
  const { default: PagesTasks } = pageModule
  const components = await autoRegisteredComponents()
  const Host = defineComponent({ components: { RouterView }, template: '<RouterView />' })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tasks', component: PagesTasks },
      { path: '/ocr', component: defineComponent({ render: () => h('div', '识别校对') }) },
      { path: '/comparison', component: defineComponent({ render: () => h('div', '比对与核查') }) },
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
const restoreLayout: Array<() => void> = []
beforeEach(() => { pageModule = null; vi.stubGlobal('useNuxtApp', () => ({})) })
afterEach(() => {
  for (const restore of restoreLayout.splice(0)) restore()
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  // A teleported drawer outlives an unmount if the page was torn down mid-open.
  for (const node of Array.from(document.body.querySelectorAll('[data-slot="sheet-content"], [data-slot="sheet-overlay"]'))) node.remove()
  restoreScrolls()
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

/** Let pending reads and microtasks settle. */
async function settle() {
  for (let i = 0; i < 40; i++) { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 5)) }
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
  const all = wrapper.findAll('button') as unknown as ButtonLike[]
  const match = all.find(b => (name instanceof RegExp ? name.test(b.text()) : b.text().includes(name)))
  if (!match) throw new Error(`button not found: ${name}. Buttons: ${all.map(b => b.text()).join(' | ')}`)
  return match
}

// Keep the legacy list flag in fixtures; per-task capabilities govern actions.
const listRead = (authorized: boolean) => json(listOf(state.list.rows, authorized))
const capabilities = json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })

/**
 * The drawer is a real Reka Sheet: it teleports into document.body, so the
 * detail is read from `document` — never from the wrapper.
 */
function sheetDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

/**
 * Wait until the drawer really is mounted.
 *
 * Reka's portal + presence mount asynchronously: the URL already carries the
 * job while the drawer is not in the DOM yet. Assertions about the drawer must
 * wait for it instead of assuming it is there.
 */
async function waitForSheet(): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const dialog = sheetDialog()
    if (dialog?.querySelector('[data-testid="task-detail-scroll"]')) return dialog
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('任务详情抽屉没有挂上来')
}

/** Wait until the drawer is gone from the document. */
async function waitForSheetClosed(): Promise<void> {
  for (let attempt = 0; attempt < 60 && sheetDialog(); attempt++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A button inside the drawer. */
function sheetButton(dialog: HTMLElement, name: RegExp): HTMLButtonElement {
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
  const match = buttons.find(button => name.test(button.textContent ?? ''))
  if (!match) throw new Error(`drawer button not found: ${name}. Buttons: ${buttons.map(b => b.textContent?.trim()).join(' | ')}`)
  return match
}

it('按清单显示模块 Tab，并在名录模块内筛选导出任务', async () => {
  const calls = installFetch(({ url, query }) => {
    if (url.endsWith('/capabilities')) return capabilities
    const filters = query as { tab: string; group?: string }
    const rows = filters.tab === 'sme-roster' ? filters.group === 'export' ? [exportTask()] : [exportTask(), platformTask()] : state.list.rows
    return json(listOf(rows, true))
  })
  const wrapper = await mountPage({ viewport: 'mobile' })
  const tabs = wrapper.findAll('[role="tab"]')
  expect(tabs.map(item => item.text().replace(/\d+$/, ''))).toEqual(['全部任务', '平台底座', '优质中小企业'])
  expect(wrapper.text()).toContain('legacy-import')
  const roster = tabs[2]!
  await roster.trigger('mousedown', { button: 0 })
  await settle()
  expect(roster.attributes('aria-selected')).toBe('true')
  expect(wrapper.text()).not.toContain('legacy-import')
  const group = wrapper.get('[aria-label="任务分组"]')
  await group.trigger('pointerdown', { button: 0, pointerType: 'mouse' })
  await group.trigger('click')
  await settle()
  const exportGroup = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === '导出')!
  expect(exportGroup).toBeTruthy()
  exportGroup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(calls.filter(call => call.url === '/api/task-center').at(-1)?.query).toMatchObject({ tab: 'sme-roster', group: 'export' })
  expect(wrapper.text()).not.toContain('平台批量查询')
  expect(wrapper.text()).toContain('专精特新“小巨人”导出')
})

describe('同源任务页面操作', () => {
  it('列表兼容 authorized=false 不阻断详情已开放的重新生成能力', async () => {
    const calls = installFetch(({ url, method }) => {
      if (url.endsWith('/capabilities')) return capabilities
      if (method === 'POST') return json({ jobId: jobId('RET') }, 202)
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      return json(listOf(state.list.rows, false))
    })
    state.query = { tab: 'sme-roster', group: 'export', job: jobId('MW') }
    await mountPage()
    await settle()
    const button = sheetButton(await waitForSheet(), /重新生成/)
    expect(button.disabled).toBe(false)
    await button.click(); await settle()
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(calls.find(call => call.method === 'POST')!.body).toMatchObject({ regenerateOf: jobId('MW') })
  })
  it('页面不收集密钥，也从不带 Bearer：任务请求只带浏览器标识头', async () => {
    const calls = installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      if (method === 'POST') return json({ jobId: jobId('RET') }, 202)
      return json(listOf(state.list.rows, true))
    })
    state.query = { tab: 'sme-roster', group: 'export', job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    await settle()
    await waitForSheet()
    sheetButton(sheetDialog()!, /重新生成/).click()
    await settle()

    // Every task request carries the browser marker — and no credential at all.
    const taskCalls = calls.filter(call => call.url.startsWith('/api/task-center'))
    expect(taskCalls.length).toBeGreaterThan(0)
    for (const call of taskCalls) {
      expect(call.headers?.['x-task-center-browser']).toBe('1')
      expect(call.headers?.authorization).toBeUndefined()
      expect(call.headers?.Authorization).toBeUndefined()
    }
    // The export submission travels the same way.
    const post = calls.find(call => call.method === 'POST')
    expect(post).toBeTruthy()
    expect(post!.headers?.['x-task-center-browser']).toBe('1')
    expect(post!.headers?.authorization).toBeUndefined()

    // And there is no authorization form anywhere on the page.
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('#task-key')).toBeNull()
    expect(document.body.textContent).not.toContain('管理操作授权')
    expect(document.body.textContent).not.toContain('应用授权')
    expect(document.body.textContent).not.toContain('清除授权')
  })

  it('任务页在名录模块保留历史导出的二级筛选', async () => {
    installFetch(({ url }) => url.endsWith('/capabilities') ? capabilities : listRead(true))
    const wrapper = await mountPage()
    await settle()
    expect(wrapper.text()).not.toContain('发起新的名录导出')
    expect(wrapper.find('[data-testid="export-action"]').exists()).toBe(false)
    expect(wrapper.find('[data-task-tab="sme-roster"]').exists()).toBe(true)
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


})

describe('任务详情抽屉', () => {
  it('打开任务用真实抽屉：URL 带 job，抽屉里有详情标题、执行详情与滚动容器', async () => {
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    const wrapper = await mountPage({ attach: true })
    await settle()

    await findButton(wrapper, /^查看/).trigger('click')
    const dialog = await waitForSheet()

    // The URL is the shareable state of "which task is open".
    expect(state.query.job).toBe(jobId('MW'))
    // The drawer is a real layer on document.body, not markup inside the page.
    expect(document.body.contains(dialog)).toBe(true)
    expect(wrapper.element.contains(dialog)).toBe(false)
    // It is named by its own title.
    const title = dialog.querySelector('[data-slot="sheet-title"]')!
    expect(title.textContent?.trim()).toBe('任务详情')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    // The detail section and its own scroll container are inside the drawer.
    expect(dialog.querySelector('section[aria-label="任务执行详情"]')).not.toBeNull()
    expect(dialog.querySelector('[data-testid="task-detail-scroll"]')).not.toBeNull()
  })

  it('关闭抽屉把 job 从 URL 去掉，抽屉也真的关掉', async () => {
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    expect(dialog.isConnected).toBe(true)

    await sheetButton(dialog, /关闭详情/).click()
    await settle()

    expect(state.query.job).toBeUndefined()
    await waitForSheetClosed()
    expect(sheetDialog()).toBeNull()
  })

  it('刷新不重挂详情、不抢焦点、不移动阅读位置', async () => {
    trackScrolls()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const detail = dialog.querySelector('section[aria-label="任务执行详情"]')
    const scroll = dialog.querySelector('[data-testid="task-detail-scroll"]')
    expect(detail).not.toBeNull()

    // The reader is looking at the drawer; the caret sits on a control of theirs.
    const anchor = sheetButton(dialog, /关闭详情/)
    anchor.focus()
    expect(document.activeElement).toBe(anchor)

    // A manual refresh of the detail.
    await sheetButton(dialog, /刷新详情/).click()
    await settle()
    expect(dialog.querySelector('section[aria-label="任务执行详情"]')).toBe(detail)
    expect(dialog.querySelector('[data-testid="task-detail-scroll"]')).toBe(scroll)
    expect(document.activeElement).toBe(anchor)
    expect(scrollIntoViewCalls).toBe(0)

    // A refresh of the list behind the drawer is just as quiet.
    await findButton(wrapper, /刷新列表/).trigger('click')
    await settle()
    expect(sheetDialog()).toBe(dialog)
    expect(dialog.querySelector('section[aria-label="任务执行详情"]')).toBe(detail)
    expect(document.activeElement).toBe(anchor)
    expect(scrollIntoViewCalls).toBe(0)
  })

  it('轮询落地的详情更新不重挂抽屉，也不移动阅读位置', async () => {
    trackScrolls()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const detail = dialog.querySelector('section[aria-label="任务执行详情"]')
    const anchor = sheetButton(dialog, /关闭详情/)
    anchor.focus()

    // The polling composable reads again every few seconds on its own.
    state.detail = exportTask({ state: 'running', progress: { done: 0, total: null, unit: '家企业', stage: '读取数据' } })
    await new Promise(resolve => setTimeout(resolve, 3100))
    await flushPromises()

    // The new snapshot really landed — in the very same drawer.
    expect(dialog.textContent).toContain('运行中')
    expect(dialog.querySelector('section[aria-label="任务执行详情"]')).toBe(detail)
    expect(document.activeElement).toBe(anchor)
    expect(scrollIntoViewCalls).toBe(0)
  })

  // Closing a detail must give the caret back to the task it came from. Both the
  // desktop <tr> and the narrow <li> carry the same `data-task-row`; exactly one of
  // them is on screen, and a hidden button cannot take focus.
  for (const viewport of ['desktop', 'mobile'] as const) {
    it(`关闭抽屉把焦点还给该任务在${viewport === 'desktop' ? '桌面表格' : '窄屏卡片'}里那个看得见的查看按钮`, async () => {
      trackScrolls()
      installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
      const wrapper = await mountPage({ attach: true, viewport })
      await flushPromises()
      // Open from the row the reader can actually see at this width.
      const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-row="${jobId('MW')}"]`)).filter(row => row.getClientRects().length > 0)

      expect(rows).toHaveLength(1)
      expect(rows[0]!.tagName).toBe(viewport === 'desktop' ? 'TR' : 'LI')
      const view = rows[0]!.querySelector<HTMLElement>('[data-row-action]')!
      view.focus()
      await view.click()
      await settle()
      expect(state.query.job).toBe(jobId('MW'))
      const dialog = await waitForSheet()

      scrollIntoViewCalls = 0
      await sheetButton(dialog, /关闭详情/).click()
      await settle()

      expect(state.query.job).toBeUndefined()
      expect(scrollIntoViewCalls).toBeGreaterThan(0)
      // Precisely the visible "查看" of this task — not the hidden twin, not <body>.
      expect(isRowActionFor(document.activeElement, jobId('MW'))).toBe(true)
      const focusedRows = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-row="${jobId('MW')}"]`)).filter(row => row.contains(document.activeElement))
      expect(focusedRows).toHaveLength(1)
      expect(focusedRows[0]!.getClientRects().length).toBeGreaterThan(0)
    })
  }

  it('从常驻条或深链打开一个不属于当前筛选的任务后关闭抽屉，焦点落到当前选中的分类，而不是 body', async () => {
    trackScrolls()
    // The open task is not in the rows the current filter returned.
    state.detail = platformTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf([exportTask()], true)))
    state.query = { tab: 'sme-roster', group: 'export', job: jobId('PLT') }
    const wrapper = await mountPage({ attach: true, viewport: 'desktop' })
    const dialog = await waitForSheet()
    expect(document.querySelector(`[data-task-row="${jobId('PLT')}"]`)).toBeNull()

    await sheetButton(dialog, /关闭详情/).click()
    await settle()

    expect(state.query.job).toBeUndefined()
    const active = document.activeElement as HTMLElement
    const selectedTab = document.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-state="active"]')!
    expect(selectedTab.dataset.taskTab).toBe('sme-roster')
    expect(active).toBe(selectedTab)
    expect(document.activeElement).not.toBe(document.body)
    expect(focusableButtons()).toContain(active)
  })

  it('只显示任务真正支持的操作：终态无取消，能力为假时不出现重试', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    expect(dialog.textContent).not.toContain('请求取消')
    expect(dialog.textContent).not.toContain('重试未完成项')
  })

  it('可取消的任务给出取消按钮，取消请求按服务端回答说话', async () => {
    state.detail = exportTask({ state: 'running', progress: { done: 0, total: null, unit: '家企业', stage: '读取数据' }, capabilities: { cancel: true, retry: false, retryItemIds: [], reason: '可请求取消；实际状态以服务端终态为准。' } })
    installFetch(({ url, method }) => {
      if (method === 'POST') return json({ cancelRequested: true })
      return url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true))
    })
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const cancel = sheetButton(dialog, /请求取消/)
    expect(cancel.disabled).toBe(false)

    await cancel.click()
    await settle()

    // The report follows the server's answer, not the moment of the request.
    const notice = dialog.querySelector('[data-testid="task-notice"]')!
    expect(notice.textContent).toMatch(/已请求取消/)
  })

  it('不可用的下载就地说明原因（过期/缺失），而不是只把按钮变灰', async () => {
    state.detail = exportTask({}, { canDownload: false, artifact: { ...exportTask().export!.artifact!, availability: 'expired' } })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()

    const download = sheetButton(dialog, /下载 Excel/)
    expect(download.disabled).toBe(true)
    const artifact = dialog.querySelector('[data-testid="export-artifact"]')!
    expect(artifact.textContent).toMatch(/下载 Excel：已过期，请重新生成/)
  })

  it('重新生成沿用该称号的导出接口，并带上被重新生成的任务编号', async () => {
    const calls = installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (method === 'POST') return json({ jobId: jobId('RET') }, 202)
      return url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true))
    })
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()

    const regenerate = sheetButton(dialog, /重新生成/)
    expect(regenerate.disabled).toBe(false)
    await regenerate.click()
    await settle()

    const post = calls.find(call => call.method === 'POST')!
    expect(post.url).toBe('/api/roster/exports/current/little-giant')
    expect((post.body as { regenerateOf?: string }).regenerateOf).toBe(jobId('MW'))
  })

  it('局部重试只补查未完成项：只发一次重试请求，并说清已完成结果保留', async () => {
    state.detail = platformTask({ capabilities: { cancel: false, retry: true, retryItemIds: ['queryBusList'], reason: '仅补查本批次未完成项，保留已完成结果。' } })
    const calls = installFetch(({ url, method }) => {
      if (method === 'POST') return json({})
      return url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true))
    })
    state.query = { job: jobId('PLT') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()

    const retry = sheetButton(dialog, /重试未完成项/)
    expect(retry.disabled).toBe(false)
    await retry.click()
    await settle()

    const posts = calls.filter(call => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`/api/task-center/${jobId('PLT')}/retry`)
    expect(posts[0]!.headers?.['x-task-center-browser']).toBe('1')
    expect(dialog.querySelector('[data-testid="task-notice"]')!.textContent).toMatch(/局部重试已受理/)
    expect(dialog.querySelector('[data-testid="task-notice"]')!.textContent).toMatch(/已完成结果保留/)
  })

  it('业务结论先于技术标识：首屏有中文类型、计数与产物状态，原始编号默认折叠', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const visible = dialog.textContent ?? ''
    expect(visible).toContain('当前名录导出')
    expect(visible).not.toContain('current-roster-export')
    // Business counts answer "what is in this export" before any technical ID.
    const counts = dialog.querySelector('[aria-label="导出口径计数"]')!
    expect(counts.textContent!.replace(/\s+/g, '')).toBe('有效1待确认0排除0')
    // The auditable identifiers stay folded away until asked for.
    expect(visible).not.toContain('sha256:db8b41')
    expect(visible).not.toContain('current-roster-116-v6')
    expect(visible).not.toContain('c22108b9')
    expect(visible).toContain('核对信息')
    // The folded panel is really collapsed: its region is closed and hidden,
    // and the technical identifiers are nowhere on screen.
    const collapsed = dialog.querySelector('[data-slot="accordion-content"]')!
    expect(collapsed.getAttribute('data-state')).toBe('closed')
    expect(collapsed.hasAttribute('hidden')).toBe(true)
    const trigger = dialog.querySelector('[data-slot="accordion-trigger"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('平台结果完整性与业务待核分开表述', () => {
  it('失败批次用完整性口径列逐项范围，并把“不代表业务结论”说清楚', async () => {
    state.detail = platformTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    // Retrieved completeness, stated as such — not an error summary.
    const outcome = dialog.querySelector('[data-testid="task-outcome"]')!.textContent!.replace(/\s+/g, '')
    expect(outcome).toContain('完整1')
    expect(outcome).toContain('部分1')
    expect(outcome).toContain('未查询1')
    // The platform caveat must keep completeness and business judgement apart.
    expect(dialog.textContent).toMatch(/完整性/)
    expect(dialog.textContent).toMatch(/不是业务判断结论|不代表正式入库/)
    // Per-item scope keeps the unfinished position visible.
    expect(dialog.textContent).toContain('queryBusList')
  })

  it('核查任务用待核实口径，不与取回完整性混为一谈', async () => {
    state.detail = platformTask({ kind: 'reconcile', label: '平台核查', outcome: null, reconcile: { targets: 2, needsReview: 3, queryFailed: 0, notQueried: 0 } })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const outcome = dialog.querySelector('[data-testid="task-outcome"]')!.textContent!.replace(/\s+/g, '')
    expect(outcome).toContain('报告目标2')
    expect(outcome).toContain('待核实3')
    expect(outcome).not.toContain('部分')
  })

  it.each([
    { name: '全槽失败', complete: 0, partial: 0, failed: 4, unknown: 0, unfinished: 4 },
    { name: '后页部分', complete: 3, partial: 1, failed: 0, unknown: 0, unfinished: 1 },
    { name: '取消未知', complete: 2, partial: 1, failed: 0, unknown: 1, unfinished: 2 },
    { name: '完整缓存', complete: 4, partial: 0, failed: 0, unknown: 0, unfinished: 0 },
  ])('核查采集$name单独使用槽位与范围单位，报告目标与待核实保持原义', async collection => {
    state.detail = platformTask({ kind: 'reconcile', label: '平台核查',
      outcome: null, reconcile: { targets: 2, needsReview: 3, queryFailed: 0, notQueried: 0 },
      reconcileCollection: { ...collection, positions: [], positionsTruncated: false },
    })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const outcome = dialog.querySelector('[data-testid="task-outcome"]')!.textContent!.replace(/\s+/g, '')
    expect(outcome).toContain('报告目标2')
    expect(outcome).toContain('待核实3')
    const collected = dialog.querySelector('[aria-label="平台采集完整性"]')?.textContent?.replace(/\s+/g, '')
    expect(collected).toContain(`完整${collection.complete}槽位`)
    expect(collected).toContain(`部分${collection.partial}槽位`)
    expect(collected).toContain(`失败${collection.failed}槽位`)
    expect(collected).toContain(`未知${collection.unknown}槽位`)
    expect(collected).toContain(`未完成${collection.unfinished}范围`)
  })

  it('核查详情按原来源、认定级别和页号定位未完成范围', async () => {
    state.detail = platformTask({ kind: 'reconcile', label: '平台核查',
      reconcileCollection: { complete: 2, partial: 1, failed: 0, unknown: 1, unfinished: 2, positionsTruncated: false,
        positions: [{ source: 'businessList', rdjb: '3', page: 2 }, { source: 'queryList', rdjb: null, page: 1 }] },
    })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const ranges = dialog.querySelector('[aria-label="未完成采集范围"]')?.textContent?.replace(/\s+/g, '')
    expect(ranges).toContain('businessList/rdjb=3/第2页')
    expect(ranges).toContain('queryList/不分认定级别/第1页')
    expect(ranges).not.toContain('全部称号')
  })

  it('核查旧报告缺采集信息明确未知，不补零或冒充完整', async () => {
    state.detail = platformTask({ kind: 'reconcile', label: '平台核查', items: [], outcome: null, reconcile: { targets: 2, needsReview: 3, queryFailed: 0, notQueried: 0 } })
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('PLT') }
    await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const collection = dialog.querySelector('[aria-label="平台采集完整性"]')?.textContent
    expect(collection).toContain('采集完整性未知')
    expect(collection).toContain('未完成范围未知')
    expect(collection).not.toMatch(/完整\s*0|未完成\s*0/)
  })
})

describe('分页', () => {
  it('深链带来的非预设每页条数在分页触发器上显示真实数字，而不是空白控件', async () => {
    installFetch(({ url, query }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      const params = (query ?? {}) as { pageSize?: number }
      const list = listOf(state.list.rows, true)
      return json({ ...list, pageSize: params.pageSize ?? list.pageSize })
    })
    state.query = { tab: 'all', pageSize: '10' }
    const wrapper = await mountPage({ attach: true })
    await settle()
    const trigger = wrapper.get('[aria-label="每页条数"]')
    // The real Reka trigger.
    expect(trigger.attributes('data-slot')).toBe('select-trigger')
    // Its own text is the number — not only the model value, and not only the
    // number sitting in the neighbouring input.
    expect(trigger.text()).toBe('10')
  })
})

describe('一次播报、一处确认', () => {
  it('一次 202 只出现一条 live region 提示；切换任务后它不跟着走', async () => {
    installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (method === 'POST') return json({ jobId: jobId('RET') }, 202)
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      return json(listOf(state.list.rows, true))
    })
    sessionStorage.setItem(EXPORT_KEY, JSON.stringify({ 'little_giant:initial': { clientRequestId: '7b7f0f2e-2a5c-4a33-9d8a-1c2b3d4e5f60', jobId: jobId('MW') } }))
    state.query = { tab: 'sme-roster', group: 'export', job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    await settle()
    await waitForSheet()
    sheetButton(sheetDialog()!, /重新生成/).click()
    await settle()

    // The standing bar states the same 202, so the filter has to look at **both**
    // live roles: an assertive bar would announce the acceptance a second time.
    const announcing = Array.from(document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]'))
      .filter(node => /已受理|已校验/.test(node.textContent ?? ''))
    expect(announcing).toHaveLength(1)
    expect(announcing[0]!.getAttribute('data-testid')).toBe('export-notice')
    expect(announcing[0]!.textContent).toMatch(/导出已受理/)
    // The standing bar keeps the request visible; it is simply not a live region.
    const bar = wrapper.get('[data-testid="export-request-bar"]')
    expect(bar.text()).toContain('已受理')
    expect(bar.attributes('role')).toBe('region')
    expect(bar.attributes('aria-label')).toBe('本次导出')
    // Switching to another task drops the notice about the previous one.
    state.query = { ...state.query, job: jobId('PLT') }
    state.detail = platformTask()
    await wrapper.vm.$router.push({ path: '/tasks', query: state.query as Record<string, string> })
    await settle()
    expect(document.querySelector('[data-testid="export-notice"]')).toBeNull()
  })
})

describe('标题层级', () => {
  it('页面 h1 → 区块 h2 → 抽屉标题 h2 → 折叠 h3，没有跳级', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const dialog = await waitForSheet()
    const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))
      .filter(node => node.isConnected && (node.textContent ?? '').trim())
      .map(node => ({ level: Number(node.tagName.slice(1)), text: (node.textContent ?? '').trim() }))
    expect(headings[0]).toEqual({ level: 1, text: '后台任务' })
    for (let index = 1; index < headings.length; index++) {
      expect(headings[index]!.level).toBeLessThanOrEqual(headings[index - 1]!.level + 1)
    }
    // The list is named by a real h2.
    expect(headings.some(heading => heading.level === 2 && heading.text === '任务列表')).toBe(true)
    expect(document.getElementById('task-list-heading')!.closest('.hidden')).toBeNull()
    // The drawer carries an h2 title of its own, and the drawer is named by it.
    const title = dialog.querySelector('[data-slot="sheet-title"]')!
    expect(title.tagName).toBe('H2')
    expect(title.textContent?.trim()).toBe('任务详情')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    // The detail's own collapsible heading stays below the drawer's title.
    const technical = headings.find(heading => heading.text === '核对信息')
    expect(technical?.level).toBe(3)
    expect(wrapper.text()).not.toContain('发起新的名录导出')
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

describe('caught task interaction reports', () => {
  it.each(['cancel', 'retry'] as const)('reports a caught %s rejection with its response request reference and fixed classification', async action => {
    const report = vi.fn()
    vi.stubGlobal('useNuxtApp', () => ({ $clientErrors: { reportInteractionFailure: report } }))
    state.detail = action === 'cancel' ? unknownTask() : platformTask()
    state.query = { job: state.detail.id }
    installFetch(({ url, method }) => method === 'POST'
      ? new Response('{}', { status: 503, headers: { 'x-request-id': `actual-${action}-180` } })
      : url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf([state.detail], true)))
    await mountPage({ attach: true })
    const dialog = await waitForSheet()
    sheetButton(dialog, action === 'cancel' ? /请求取消/ : /重试未完成项/).click()
    await settle()
    expect(report).toHaveBeenCalledExactlyOnceWith(`task_${action}`, `actual-${action}-180`)
    expect(dialog.textContent).toContain('操作未受理')
  })
  it('reports a caught artifact integrity failure using the successful HTTP response reference', async () => {
    const report = vi.fn()
    vi.stubGlobal('useNuxtApp', () => ({ $clientErrors: { reportInteractionFailure: report } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad-xlsx', { headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${state.detail.export!.artifact!.filename}"`,
      'x-request-id': 'artifact-response-180',
    } })))
    state.query = { job: state.detail.id, tab: 'sme-roster', group: 'export' }
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf([state.detail], true)))
    await mountPage({ attach: true })
    const dialog = await waitForSheet()
    sheetButton(dialog, /下载 Excel/).click()
    await settle()
    expect(report).toHaveBeenCalledExactlyOnceWith('task_artifact_download', 'artifact-response-180')
    expect(document.body.textContent).toContain('下载未完成或文件校验失败')
  })
})

it('navigates the snapshot result link to the task section and shows unfinished as unknown rows', async () => {
  state.detail = platformTask({ kind: 'difference-snapshot', label: '公布名单归档快照', outcome: null,
    snapshot: { enterprises: 2, requests: 3, rows: 5, unfinished: 1, truncated: false,
      positions: [{ enterpriseId: 12, source: 'queryList', rdjb: null, rows: null, page: 2 }] },
    links: [{ label: '快照范围、计数与未完成位置', to: `/tasks?tab=sme-roster&group=platform&job=${platformTask().id}#snapshot-result` }],
  })
  state.query = { tab: 'sme-roster', group: 'platform', job: state.detail.id }
  installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf([state.detail], true)))
  await mountPage({ attach: true })
  const dialog = await waitForSheet()
  const link = Array.from(dialog.querySelectorAll('a')).find(a => a.textContent === '快照范围、计数与未完成位置')!
  expect(link).toBeTruthy()
  link.click(); await flushPromises()
  expect(routerRef.current!.currentRoute.value.fullPath).toBe(`/tasks?tab=sme-roster&group=platform&job=${state.detail.id}#snapshot-result`)
  const section = dialog.querySelector('#snapshot-result')!
  expect(section.textContent).toContain('本任务选定公布企业 · 2 家')
  expect(section.textContent).toContain('未完成 1 范围')
  expect(section.textContent).toContain('第 2 页待续 · 行数 未知')
})
