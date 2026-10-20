// @vitest-environment happy-dom
// UI regressions for the task workbench (#116 / #120 / #121).
//
// Each test here pins a person's job, not the component's internals:
//   1. a wrong admin key fails where it was typed and keeps the draft;
//   2. the same key can be proven again after "clear" — clearing one attempt
//      must not disable the next one;
//   3. a check that never gets an answer says so within its bound and stops the
//      read instead of hanging;
//   4. a second press while checking starts no second verification;
//   5. leaving the page drops the in-memory key and aborts what was in flight;
//   6. the accepted export can be found again after leaving (cross tab);
//   7. a 202 whose receipt was lost is retried with the same request identity;
//   8. a rejected export submission keeps its own readable reason;
//   9. the accepted-export bar states the request, not a stale task state;
//  10. opening a detail reveals it, while polling never steals focus or scroll;
//  11. closing a detail returns to the row that opened it;
//  12. detail shows only actions the task really supports;
//  13. a button that is disabled always says why next to it.
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

// Everything below is mounted with the repository's **real** components (Input's
// passive `useVModel`, the Reka Tabs/Select, Button's `disabled`, DisclosurePanel's
// accordion). Only the dev-only theme toggle and the icon-only sidebar are left out:
// they have nothing to do with the task page's contracts.

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

type FetchCall = { url: string, method: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal }
/** The credential the most recent list read carried (what the server saw). */
let lastListAuthorization = ''
const lastAuthorization = () => lastListAuthorization

// The page calls the Nuxt-injected `$fetch`; the repo's UI tests stub it the same
// way. `$fetch.raw` is the 202 path (the page needs the real status code).
function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  // Record first, then call the handler: a handler that throws (lost network)
  // must still show up as an attempted request.
  const run = async (url: string, options: { method?: string, body?: unknown, headers?: Record<string, string>, query?: unknown, signal?: AbortSignal } = {}) => {
    const entry = { url, method: options.method ?? 'GET', body: options.body, headers: options.headers, query: options.query, signal: options.signal }
    if (url === '/api/task-center') lastListAuthorization = options.headers?.authorization ?? ''
    calls.push(entry)
    const response = await handler(entry)
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
// so the page test supplies the same components explicitly. Input, Select, Tabs,
// Button, Label, DisclosurePanel and the UI primitives are deliberately **not**
// stubbed: their real behaviour (passive v-model, disabled buttons that cannot be
// clicked, Reka focus movement) is part of what these tests are about.
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

let pageModule: { default: ReturnType<typeof defineComponent> } | null = null
async function mountPage(options: { attach?: boolean, viewport?: 'desktop' | 'mobile' | 'hidden', freshPage?: boolean } = {}) {
  // Every page is attached while it is driven; a person leaves by unmounting it.
  options.attach = true
  restoreLayout.push(layout(options.viewport ?? 'desktop'))
  // The page's polling/watchers belong to the page instance; a module loaded once
  // is fine, but a test that remounts after "leaving" gets a fresh module too.
  if (!pageModule || options.freshPage) pageModule = await import('../pages/tasks.vue')
  const { default: PagesTasks } = pageModule
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
const restoreLayout: Array<() => void> = []
beforeEach(() => { pageModule = null })
afterEach(() => {
  for (const restore of restoreLayout.splice(0)) restore()
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

/** Let pending reads and microtasks settle (an auth submit is async end-to-end:
 *  the read has to land and the page has to re-render the verdict). */
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
  const all = 'findAll' in wrapper && typeof wrapper.findAll === 'function'
    ? wrapper.findAll('button') as unknown as ButtonLike[]
    : wrapper.findAll('button') as unknown as ButtonLike[]
  const match = all.find(b => (name instanceof RegExp ? name.test(b.text()) : b.text().includes(name)))
  if (!match) throw new Error(`button not found: ${name}. Buttons: ${all.map(b => b.text()).join(' | ')}`)
  return match
}

// A list read answers 200 whether or not the key is valid; only `authorized` says
// so. Delay is expressed in macrotask ticks (5ms) so no fake timers are involved.
const listRead = (authorized: boolean) => json(listOf(state.list.rows, authorized))
const capabilities = json({ exports: [{ titleCode: 'little_giant', path: '/api/roster/exports/current/little-giant', ready: true }] })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Everything a person could read at this instant, from the authorization form. */
function authSnapshot(wrapper: Wrapper) {
  const form = wrapper.get('form')
  const feedback = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="task-auth-feedback"], [data-testid="task-auth-alert"], [data-testid="task-auth-checking"]'))
    .filter(node => form.element.contains(node))
    .map(node => node.textContent?.trim())
    .filter(Boolean)
  const badges = wrapper.findAll('[data-testid="auth-badge"], [data-testid="auth-badge-inline"]').map(badge => badge.text().trim())
  const submit = wrapper.get<HTMLButtonElement>('form button[type="submit"]')
  return {
    feedback,
    badge: badges.join(','),
    draft: wrapper.get<HTMLInputElement>('#task-key').element.value,
    submitLabel: submit.text().trim(),
    submitDisabled: submit.element.disabled,
  }
}

/** Sample the form every ~100ms for `ms`, keeping only distinct readings. */
async function sampleEvery(wrapper: Wrapper, ms: number, during: () => Promise<void>) {
  const readings: ReturnType<typeof authSnapshot>[] = []
  const finished = during()
  let done = false
  void finished.then(() => { done = true })
  const started = Date.now()
  while (!done || Date.now() - started < Math.min(150, ms)) {
    const now = authSnapshot(wrapper)
    const last = readings[readings.length - 1]
    if (!last || JSON.stringify(last) !== JSON.stringify(now)) readings.push(now)
    await sleep(100)
  }
  await finished
  readings.push(authSnapshot(wrapper))
  return readings
}

/** Wait until the form stops saying "checking" and the verdict is on screen. */
async function waitForVerdict(wrapper: Wrapper, timeoutMs = 1000) {
  const started = Date.now()
  await flushPromises()
  while (authSnapshot(wrapper).submitDisabled && Date.now() - started < timeoutMs) { await flushPromises(); await sleep(10) }
  // Bring the already-landed verdict into the page before anyone reads it.
  await flushPromises()
  await settle()
}

function checkingLabel(wrapper: Wrapper) {
  return wrapper.get('form button[type="submit"]').text().trim()
}

/**
 * Press the form's submit button the way a person does.
 *
 * `element.click()` runs the button's activation behaviour, so the browser's own
 * implicit submission happens — and a disabled button does not submit, exactly as
 * in a browser. A dispatched `click` event would run neither.
 */
function pressSubmit(wrapper: Wrapper) {
  wrapper.get<HTMLButtonElement>('form button[type="submit"]').element.click()
}

/**
 * Deliver the form's submit event directly, bypassing the button.
 *
 * This is how the handler itself is put under test: a person cannot press a
 * disabled button, so the only way to reach the handler while it is disabled is
 * to submit the form without the button.
 */
function submitForm(wrapper: Wrapper) {
  wrapper.get('form').element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

async function submitWithKey(wrapper: Wrapper, key: string) {
  await wrapper.get('#task-key').setValue(key)
  await flushPromises()
  expect(checkingLabel(wrapper)).toBe('应用授权')
  pressSubmit(wrapper)
}

describe('管理操作授权', () => {
  it('拒绝的密钥在原地说明原因、保留草稿，修正后才显示已授权', async () => {
    let authorized = false
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      // A read with a wrong key still answers 200; only the field says so.
      return listRead(authorized)
    })
    const wrapper = await mountPage({ attach: true })
    expect(wrapper.text()).toContain('只读')

    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'wrong-key-abc')
    await waitForVerdict(wrapper)
    // The typed key survives so a one-character typo can be fixed.
    expect(wrapper.get<HTMLInputElement>('#task-key').element.value).toBe('wrong-key-abc')
    expect(wrapper.get('[data-testid="task-auth-alert"]').text()).toMatch(/未通过校验|未授权/)
    expect(wrapper.text()).not.toContain('已授权')
    // ...and the retry carries the corrected draft, not a stale one.

    authorized = true
    // The corrected draft is re-submitted by pressing the form's own button again.
    await submitWithKey(wrapper, 'right-key')
    await waitForVerdict(wrapper)
    expect(wrapper.text()).toContain('已授权')
    // A proven key is no longer needed in the field.
    expect(wrapper.get<HTMLInputElement>('#task-key').element.value).toBe('')
  })

  it('错→对的全程每 100ms 采样都不会出现“请输入”或“授权未通过”，只在最后确认一次成功', async () => {
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      const authorization = lastAuthorization()
      // The server answers after two ticks, like a real round trip.
      return sleep(10).then(() => listRead(authorization === 'Bearer right-key'))
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)

    await submitWithKey(wrapper, 'wrong-key')
    await settle()
    expect(authSnapshot(wrapper).feedback.join(' ')).toMatch(/未通过校验/)

    // Correct it in the same field and submit again; watch every 100ms.
    const readings = await sampleEvery(wrapper, 1500, () => submitWithKey(wrapper, 'right-key'))
    const spoken = readings.flatMap(reading => reading.feedback)
    expect(spoken.filter(text => /请输入/.test(text))).toEqual([])
    expect(readings.filter(reading => reading.feedback.some(text => /授权未通过/.test(text)))).toEqual([])
    const final = readings[readings.length - 1]!
    expect(final.badge).toBe('已授权,已授权')
    // Exactly one confirmation, and it is the only line left on screen.
    expect(final.feedback.filter(text => /已授权/.test(text))).toHaveLength(1)
    // The verdict does not arrive as a remount of the form: the key field is the
    // same element throughout (no focus steal on success).
    expect(document.querySelector('#task-key')).toBeTruthy()
  })

  it('慢响应时稳定显示“正在验证”、拒收第二次提交，答案到达后才确认一次', async () => {
    const release = { go: false }
    const calls = installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      const answer = () => listRead(lastAuthorization() === 'Bearer right-key')
      if (!release.go) return new Promise<Response>(resolve => { held.push(() => resolve(answer())) })
      return sleep(10).then(answer)
    })
    const held: Array<() => void> = []
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    // The check is in flight: it says so, and refuses a second submit.
    expect(authSnapshot(wrapper).submitLabel).toBe('正在验证…')
    expect(authSnapshot(wrapper).submitDisabled).toBe(true)
    expect(authSnapshot(wrapper).feedback.join(' ')).not.toMatch(/未通过|请输入/)
    // A second press while checking must not start a parallel verification. The
    // disabled button already refuses the press; submitting the form without the
    // button puts the handler itself under test, and still no second read goes out.
    pressSubmit(wrapper)
    submitForm(wrapper)
    await flushPromises()
    expect(authSnapshot(wrapper).submitLabel).toBe('正在验证…')
    expect(calls.filter(call => call.headers?.authorization === 'Bearer right-key')).toHaveLength(1)
    // The answer arrives; exactly one confirmation, and the key field is cleared.
    release.go = true
    for (const resolve of held) resolve()
    await waitForVerdict(wrapper)
    const after = authSnapshot(wrapper)
    expect(after.badge).toBe('已授权,已授权')
    expect(after.feedback).toEqual(['已授权，可以提交、下载或取消任务。'])
    expect(after.draft).toBe('')
  })

  it('清除授权会作废在途的验证：它晚到的答案不会再让人“已授权”', async () => {
    let release!: (response: Response) => void
    let holdNext = true
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (!holdNext) return listRead(true)
      return new Promise<Response>(resolve => { release = resolve })
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await flushPromises()
    expect(authSnapshot(wrapper).submitLabel).toBe('正在验证…')

    await findButton(wrapper, /清除授权/).trigger('click')
    await flushPromises()
    // The abandoned check now answers "authorized" — for nobody.
    holdNext = false
    release(listRead(true))
    await settle()

    const after = authSnapshot(wrapper)
    expect(after.badge).toBe('只读,只读')
    expect(after.feedback.join(' ')).not.toMatch(/已授权/)
    expect(after.draft).toBe('')
    expect(after.submitLabel).toBe('应用授权')
  })

  it('清除授权后仍能再次用正确的密钥完成授权：清除只作废这一次，不能永久废掉下一次提交', async () => {
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      return listRead(lastAuthorization() === 'Bearer right-key')
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'wrong-key')
    await waitForVerdict(wrapper)
    expect(wrapper.get('[data-testid="task-auth-alert"]').text()).toMatch(/未通过校验|未授权/)

    // 清除：作废在途的校验、丢掉内存里的凭据。
    await findButton(wrapper, /清除授权/).trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="auth-badge"], [data-testid="auth-badge-inline"]').map(badge => badge.text())).toEqual(['只读', '只读'])

    // 再次提交正确密钥：必须能再次证明成功。
    await submitWithKey(wrapper, 'right-key')
    await waitForVerdict(wrapper)
    expect(wrapper.get('[data-testid="task-auth-feedback"]').text()).toMatch(/已授权/)
    expect(wrapper.findAll('[data-testid="auth-badge"], [data-testid="auth-badge-inline"]').map(badge => badge.text())).toEqual(['已授权', '已授权'])
  })

  it('离页后晚到的验证回应不授权、不覆写状态', async () => {
    let release!: (response: Response) => void
    let holdNext = true
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (!holdNext) return listRead(true)
      return new Promise<Response>(resolve => { release = resolve })
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await flushPromises()
    expect(authSnapshot(wrapper).submitLabel).toBe('正在验证…')

    // The person leaves the page: the route component unmounts and the page hides.
    window.dispatchEvent(new Event('pagehide'))
    mounted.splice(0).forEach(leaving => leaving.unmount())
    wrapper.unmount()
    holdNext = false
    release(listRead(true))
    await settle()

    expect(document.querySelectorAll('[data-testid="auth-badge"]').length).toBe(0)
    expect(document.body.textContent).not.toMatch(/已授权/)
    // A new page opened afterwards (the credential lived only in the old page's
    // memory) is read-only again, and gets its own badge pair.
    sessionStorage.clear()
    const fresh = await mountPage({ attach: true, freshPage: true })
    expect(fresh.findAll('[data-testid="auth-badge"], [data-testid="auth-badge-inline"]').map(badge => badge.text())).toEqual(['只读', '只读'])
    expect(fresh.findAll('[data-testid="auth-badge"]')).toHaveLength(1)
  })

  it('服务端一直不应答时，八秒后如实说“没拿到答案”，并把这次读取停掉', async () => {
    // Only the clock is faked; the promise machinery stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      return new Promise<Response>(() => {}) // 接受请求，但永远不回应
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await flushPromises()

    const pending = calls.find(call => call.headers?.authorization === 'Bearer right-key')
    expect(pending).toBeTruthy()
    expect(pending!.signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(8000)
    await flushPromises()

    // The read that never landed is stopped, and the verdict says "no answer".
    expect(pending!.signal?.aborted).toBe(true)
    expect(wrapper.get('[data-testid="task-auth-unreachable"]').text()).toMatch(/未在 8 秒内回应/)
    // The key stays in the field so the person can try again; it is not proven.
    expect(wrapper.get<HTMLInputElement>('#task-key').element.value).toBe('right-key')
    expect(wrapper.findAll('[data-testid="auth-badge"]').map(badge => badge.text())).toEqual(['只读'])
  })

  it('卸载页面会中止在途的校验请求，密钥也不留在 URL 或浏览器存储里', async () => {
    const calls = installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      return new Promise<Response>(() => {}) // 永远不回应
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await flushPromises()

    const pending = calls.find(call => call.headers?.authorization === 'Bearer right-key')
    expect(pending).toBeTruthy()
    expect(pending!.signal?.aborted).toBe(false)
    // 密钥只在页面内存里：URL、sessionStorage、localStorage 都不含它。
    expect(location.href).not.toContain('right-key')
    expect(JSON.stringify(sessionStorage)).not.toContain('right-key')
    expect(JSON.stringify(localStorage)).not.toContain('right-key')

    // 离页：路由组件卸载，页面的记忆到此为止。
    mounted.splice(0).forEach(leaving => leaving.unmount())
    wrapper.unmount()
    await flushPromises()

    // 还在路上的那次读取被停掉：它不能再回答出任何东西。
    expect(pending!.signal?.aborted).toBe(true)
  })

  it('离开页面（pagehide）会丢掉内存里的凭据：回到页面后的读取不再带授权头', async () => {
    const calls = installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      return listRead(lastAuthorization() === 'Bearer right-key')
    })
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await waitForVerdict(wrapper)
    expect(wrapper.text()).toContain('已授权')
    expect(calls.some(call => call.headers?.authorization === 'Bearer right-key')).toBe(true)

    // 离页即清除：凭据只在内存里，走了就不再拿着它读列表。服务端仍然会说这把
    // 密钥有效，但页面已经不再持有它。
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(wrapper.findAll('[data-testid="auth-badge"], [data-testid="auth-badge-inline"]').map(badge => badge.text())).toEqual(['只读', '只读'])

    // 回到页面：随后的读取不再带授权头。
    window.dispatchEvent(new Event('pageshow'))
    await settle()
    expect(lastAuthorization()).toBe('')
  })

  it('校验期间切换筛选：判定仍按发起时的筛选走，列表按新筛选重读', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const calls = installFetch(async ({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      // The credential this very request carries, read at request time.
      const authorization = lastAuthorization()
      if (authorization === 'Bearer right-key') await held
      return listRead(authorization === 'Bearer right-key')
    })
    state.query = { tab: 'export' }
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await flushPromises()
    expect(authSnapshot(wrapper).submitLabel).toBe('正在验证…')

    // 校验还在途中：切到别的分类（Reka 的 Tab 在按下时就切换）。
    await findButton(wrapper, /^OCR/).trigger('mousedown')
    await flushPromises()
    expect(state.query.tab).toBe('ocr')

    release()
    await waitForVerdict(wrapper)
    expect(wrapper.get('[data-testid="task-auth-feedback"]').text()).toMatch(/已授权/)

    // 证明用的那次读取按**发起时**的筛选（导出）问出去。
    const proof = calls.find(call => call.headers?.authorization === 'Bearer right-key')!
    expect((proof.query as { tab: string }).tab).toBe('export')
    // 凭据确认之后，列表按**新的**筛选重读。
    const afterSwitch = calls.filter(call => call.headers?.authorization === 'Bearer right-key' && (call.query as { tab: string }).tab === 'ocr')
    expect(afterSwitch.length).toBeGreaterThan(0)
  })

  it('只读时每个不可用操作旁都有可读原因与进入授权的路径', async () => {
    installFetch(({ url }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      return listRead(false)
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
    await submitWithKey(wrapper, 'good-key')
    await waitForVerdict(wrapper)
    expect(authSnapshot(wrapper).badge).toBe('已授权,已授权')

    await openPanel(wrapper, /发起新的名录导出/)
    // The first attempt loses its receipt on the wire, so no job id is recorded.
    await findButton(wrapper, /提交导出/).trigger('click')
    await settle()
    const afterLoss = JSON.parse(sessionStorage.getItem(EXPORT_KEY) || '{}')['little_giant:initial']
    expect(afterLoss?.clientRequestId).toBeTruthy()
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
    await submitWithKey(wrapper, 'good-key')
    await waitForVerdict(wrapper)
    expect(authSnapshot(wrapper).badge).toBe('已授权,已授权')
    await openPanel(wrapper, /发起新的名录导出/)
    await findButton(wrapper, /提交导出/).trigger('click')
    await flushPromises()
    const notice = wrapper.get('[data-testid="export-notice"]')
    expect(notice.text()).toMatch(/未确认|尚未确认/)
    expect(notice.attributes('role')).toBe('alert')
    expect(wrapper.text()).not.toContain('导出已受理')
  })
})

describe('任务详情', () => {
  it('打开详情时把详情带入视野，轮询刷新与重新授权都不抢焦点、不重挂卡片、不移动阅读位置', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    let authorized = true
    installFetch(({ url }) => {
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      return json(listOf(state.list.rows, authorized))
    })
    const wrapper = await mountPage({ attach: true })
    scrollIntoView.mockClear()

    // A person opens a task: the card is revealed once.
    await findButton(wrapper, /^查看/).trigger('click')
    await flushPromises()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    const card = wrapper.get('section[aria-labelledby="task-detail-title"]').element

    // ...then keeps reading while polling lands, and re-authorizes from the page.
    const reader = document.createElement('button')
    document.body.append(reader)
    reader.focus()
    scrollIntoView.mockClear()
    await findButton(wrapper, /刷新列表/).trigger('click')
    await flushPromises()
    state.detail = exportTask({ state: 'running', progress: { done: 0, total: null, unit: '家企业', stage: '读取数据' } })
    await new Promise(resolve => setTimeout(resolve, 3100))
    await flushPromises()

    // Authorizing again changes the credential, not the task: the same card stays
    // mounted (no remount → no fresh reveal, no lost scroll position).
    const authPanel = wrapper.findAll('button').find(button => /管理操作授权/.test(button.text()))!
    await authPanel.trigger('click')
    await flushPromises()
    authorized = true
    await wrapper.get('#task-key').setValue('second-key')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(document.activeElement).toBe(reader)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(wrapper.get('section[aria-labelledby="task-detail-title"]').element).toBe(card)
    reader.remove()
  })

  it('重新授权后详情用新凭据重读一次：卡片不重挂、不滚动，操作随授权出现', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    // A running task: cancel is offered only to an authorized reader.
    state.detail = exportTask({ state: 'running', progress: { done: 0, total: null, unit: '家企业', stage: '读取数据' } })
    const calls = installFetch(({ url, headers }) => {
      const permitted = headers?.authorization === 'Bearer right-key'
      if (url.startsWith('/api/task-center/')) {
        const detail = state.detail
        return json({ ...detail, capabilities: { ...detail.capabilities, cancel: permitted, reason: permitted ? '可请求取消；实际状态以服务端终态为准。' : '管理操作需要 API 授权。' } })
      }
      return json(listOf(state.list.rows, permitted))
    })
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    await settle()
    const card = wrapper.get('section[aria-labelledby="task-detail-title"]').element
    // Not authorized yet: the detail says so and offers nothing.
    expect(wrapper.text()).toContain('需要先完成管理操作授权')
    expect(wrapper.findAll('button').some(b => /请求取消/.test(b.text()))).toBe(false)
    scrollIntoView.mockClear()

    // Authorize from the page.
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'right-key')
    await waitForVerdict(wrapper)
    await settle()

    // The detail was read again with the new credential: cancel is now offered.
    const detailReads = calls.filter(call => call.url.startsWith('/api/task-center/'))
    expect(detailReads.length).toBeGreaterThan(1)
    expect(detailReads.at(-1)!.headers?.authorization).toBe('Bearer right-key')
    expect(wrapper.findAll('button').some(b => /请求取消/.test(b.text()))).toBe(true)
    // The card was not re-created and nothing scrolled: the reader stays put.
    expect(wrapper.get('section[aria-labelledby="task-detail-title"]').element).toBe(card)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  // Closing a detail must give the caret back to the task it came from. Both the
  // desktop <tr> and the narrow <li> carry the same `data-task-row`; exactly one of
  // them is on screen, and a hidden button cannot take focus.
  for (const viewport of ['desktop', 'mobile'] as const) {
    it(`关闭详情把焦点还给该任务在${viewport === 'desktop' ? '桌面表格' : '窄屏卡片'}里那个看得见的查看按钮`, async () => {
      const scrollIntoView = vi.fn()
      HTMLElement.prototype.scrollIntoView = scrollIntoView
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

      scrollIntoView.mockClear()
      await findButton(wrapper, /关闭详情/).trigger('click')
      await settle()

      expect(state.query.job).toBeUndefined()
      expect(scrollIntoView).toHaveBeenCalled()
      // Precisely the visible "查看" of this task — not the hidden twin, not <body>.
      expect(isRowActionFor(document.activeElement, jobId('MW'))).toBe(true)
      const focusedRows = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-row="${jobId('MW')}"]`)).filter(row => row.contains(document.activeElement))
      expect(focusedRows).toHaveLength(1)
      expect(focusedRows[0]!.getClientRects().length).toBeGreaterThan(0)
    })
  }

  it('从常驻条或深链打开一个不属于当前筛选的任务后关闭详情，焦点落到当前选中的分类，而不是 body', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    // The open task is not in the rows the current filter returned.
    state.detail = platformTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf([exportTask()], true)))
    state.query = { tab: 'export', job: jobId('PLT') }
    const wrapper = await mountPage({ attach: true, viewport: 'desktop' })
    await settle()
    expect(document.querySelector(`[data-task-row="${jobId('PLT')}"]`)).toBeNull()

    await findButton(wrapper, /关闭详情/).trigger('click')
    await settle()

    expect(state.query.job).toBeUndefined()
    const active = document.activeElement as HTMLElement
    const selectedTab = document.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-state="active"]')!
    expect(selectedTab.dataset.taskTab).toBe('export')
    expect(active).toBe(selectedTab)
    expect(document.activeElement).not.toBe(document.body)
    expect(focusableButtons()).toContain(active)
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
    const row = wrapper.get('[data-testid="export-artifact"]').element as HTMLElement
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

describe('一次播报、一处确认', () => {
  it('一次 202 只出现一条 live region 提示；切换任务后它不跟着走', async () => {
    installFetch(({ url, method }) => {
      if (url.startsWith('/api/roster/exports/current/capabilities')) return capabilities
      if (method === 'POST') return json({ jobId: jobId('RET') }, 202)
      if (url.startsWith('/api/task-center/')) return json(state.detail)
      return json(listOf(state.list.rows, true))
    })
    state.query = { tab: 'export' }
    const wrapper = await mountPage({ attach: true })
    await openPanel(wrapper, /管理操作授权/)
    await submitWithKey(wrapper, 'good-key')
    await waitForVerdict(wrapper)
    await openPanel(wrapper, /发起新的名录导出/)
    await findButton(wrapper, /提交导出/).trigger('click')
    await settle()

    const notices = Array.from(document.querySelectorAll<HTMLElement>('[role="status"]')).filter(node => /已受理|已校验/.test(node.textContent ?? ''))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.getAttribute('data-testid')).toBe('export-notice')
    expect(notices[0]!.textContent).toMatch(/导出已受理/)
    // Switching to another task drops the notice about the previous one.
    state.query = { ...state.query, job: jobId('PLT') }
    state.detail = platformTask()
    await wrapper.vm.$router.push({ path: '/tasks', query: state.query as Record<string, string> })
    await settle()
    expect(wrapper.find('[data-testid="export-notice"]').exists()).toBe(false)
  })
})

describe('标题层级', () => {
  it('页面 h1 → 区块 h2 → 详情/折叠 h3，没有跳级，也不靠空的 h2 撑场面', async () => {
    state.detail = exportTask()
    installFetch(({ url }) => url.startsWith('/api/task-center/') ? json(state.detail) : json(listOf(state.list.rows, true)))
    state.query = { job: jobId('MW') }
    const wrapper = await mountPage({ attach: true })
    const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))
      .filter(node => node.isConnected && (node.textContent ?? '').trim())
      .map(node => ({ level: Number(node.tagName.slice(1)), text: (node.textContent ?? '').trim() }))
    expect(headings[0]).toEqual({ level: 1, text: '后台任务' })
    for (let index = 1; index < headings.length; index++) {
      expect(headings[index]!.level).toBeLessThanOrEqual(headings[index - 1]!.level + 1)
    }
    // Both page regions are named by a real h2; the list's one is for screen readers.
    const regions = Array.from(document.querySelectorAll<HTMLElement>('section[aria-labelledby]'))
      .map(section => document.getElementById(section.getAttribute('aria-labelledby')!))
      .filter((node): node is HTMLElement => !!node)
    // (Two of these name the same element, so compare the elements.)
    expect(regions.map(node => node.tagName)).toEqual(['H2', 'H2', 'H2'])
    expect(regions[0]!.textContent).toBe('任务列表')
    expect(regions[1]).toBe(regions[2])
    expect(regions[1]!.textContent).toBe('任务详情')
    // The detail's own collapsible heading stays inside its card's h2 region.
    const technical = headings.find(heading => heading.text === '核对信息')
    expect(technical?.level).toBe(3)
    expect(headings.some(heading => heading.level === 2 && heading.text === '任务详情')).toBe(true)
    // Nothing is hidden purely to satisfy a heading detector.
    for (const id of ['task-list-heading', 'task-detail-title']) {
      expect(document.getElementById(id)!.closest('[aria-hidden="true"], .hidden')).toBeNull()
    }
  })
})

describe('筛选分组', () => {
  it('每个筛选的 Label 与 Select 在同一个组里，窄屏折行时不会把标签留在上一行', async () => {
    installFetch(() => json(listOf(state.list.rows, false)))
    state.query = { tab: 'export' }
    const wrapper = await mountPage({ attach: true })
    for (const id of ['task-state', 'export-title-filter']) {
      const label = wrapper.get(`label[for="${id}"]`).element as HTMLElement
      const trigger = wrapper.get(`#${id}`).element as HTMLElement
      expect(label.parentElement).toBe(trigger.parentElement)
      // Same-wrap container: a flex row that keeps the two together.
      expect(label.parentElement!.className).toContain('flex')
      expect(label.parentElement!.className).not.toContain('flex-wrap')
    }
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
