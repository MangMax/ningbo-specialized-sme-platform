// @vitest-environment happy-dom
// Component seam only: proves the configuration UI's draft/PATCH contract in
// happy-dom, not real browser behaviour. One case mounts the component with a
// real service policy response so the rendered catalog cannot drift from the
// backend shape without a failing test. Desktop and 390px operation stays a
// separate manual acceptance lane.
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LogFieldControls, LogFieldControlsPatch } from '../../../layers/core/lib/logging/contract'
import { LOG_FIELD_PROFILES } from '../../../layers/core/lib/logging/field-controls'
import { createLogService } from '../../../layers/core/lib/logging/service'

vi.mock('motion-v', async (original) => {
  const actual = await original<typeof import('motion-v')>()
  const { ref } = await import('vue')
  return { ...actual, useReducedMotion: () => ref(true) }
})

const wrappers: ReturnType<typeof mount>[] = []
const services: ReturnType<typeof createLogService>[] = []
const directories: string[] = []
afterEach(async () => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  for (const service of services.splice(0)) await service.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete (navigator as any).clipboard
})
/** Owned temp log directory; never a business database or a shared fixture. */
function ownedDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'f03-field-ui-'))
  directories.push(directory)
  return directory
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
type TestLevel = (typeof LEVELS)[number]
const LEVEL_LABELS: Record<string, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' }
const HTTP_FIELDS = ['httpMethod', 'httpRoute', 'statusCode', 'durationMs'] as const
const TUS_FIELDS = ['tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'] as const
const label = (profile: string, field: string) =>
  LOG_FIELD_PROFILES.find((entry) => entry.key === profile)!.fields.find(
    (entry) => entry.key === field
  )!.label

/** Test-only Icon stub: Nuxt auto-imports Icon in the app; Vitest needs a stand-in. */
const IconStub = {
  props: ['name'],
  template: '<span class="icon-stub" :data-icon="name"></span>'
}

/**
 * The response catalog is the real backend table (HTTP + TUS), not a local copy:
 * if the backend renames a profile/level/field the UI tests fail instead of drift.
 */
const profileCatalog = () => LOG_FIELD_PROFILES
/** Complete effective controls over the real catalog, all true by default. */
const defaultControls = (): LogFieldControls => {
  const controls: Record<string, Record<string, Record<string, boolean>>> = {}
  for (const profile of LOG_FIELD_PROFILES) {
    const levels: Record<string, Record<string, boolean>> = {}
    for (const level of LEVELS) {
      const fields: Record<string, boolean> = {}
      const keys = profile.key === 'tus' ? TUS_FIELDS : HTTP_FIELDS
      for (const key of keys) fields[key] = true
      levels[level] = fields
    }
    controls[profile.key] = levels
  }
  return controls as LogFieldControls
}
const controlsWith = (
  level: TestLevel,
  overrides: Partial<Record<(typeof HTTP_FIELDS)[number], boolean>>
) => {
  const controls = defaultControls() as unknown as Record<
    string,
    Record<TestLevel, Record<string, boolean>>
  >
  Object.assign(controls.http![level], overrides)
  return controls as unknown as LogFieldControls
}
const integrationCatalog = [
  { key: 'nuxt-nitro', label: 'Nuxt / Nitro 请求', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'mcp-toolkit', label: 'MCP Toolkit 模块上下文', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'tus', label: 'tus 服务端回调', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'application', label: '应用手动埋点', state: 'supported', configurable: true, category: 'business', runtimes: ['node', 'browser'] }
] as const
/** Includes `file` because the real TUS profile is source=file. */
const sourceKeys = ['http', 'mcp', 'task', 'file'] as const
const rule = (over: Partial<{ enabled: boolean; minLevel: TestLevel }> = {}) => ({
  enabled: true,
  minLevel: 'debug' as TestLevel,
  ...over
})
const basePolicy = (over: Record<string, unknown> = {}) => ({
  retentionDays: 7,
  maxBytes: 536870912,
  storageBytes: 4096,
  pruned: 0,
  cleared: 0,
  accounting: 'main+sidecars',
  status: { dropped: 0, unavailable: false },
  collection: {
    sources: Object.fromEntries(sourceKeys.map((key) => [key, rule()])),
    integrations: Object.fromEntries(integrationCatalog.map((entry) => [entry.key, rule()]))
  },
  fieldControls: defaultControls(),
  catalog: { integrations: integrationCatalog, profiles: profileCatalog() },
  revision: 1,
  ...over
})

/** GET returns the latest server state; PATCH goes through the supplied writer. */
async function mountManagement(
  read: () => Record<string, unknown>,
  write?: (body: any) => Record<string, unknown>
) {
  const calls: { url: string; options: any }[] = []
  vi.stubGlobal('$fetch', async (url: string, options: any = {}) => {
    calls.push({ url, options })
    if (options.method === 'PATCH') return write ? write(options.body) : read()
    return read()
  })
  const { default: Management } = await import('../../../layers/core/app/components/logs/LogManagement.vue')
  const wrapper = mount(Management, {
    props: { filter: {} },
    attachTo: document.body,
    global: { stubs: { Icon: IconStub } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, calls }
}
const patches = (calls: { options: any }[]) =>
  calls.filter((call) => call.options?.method === 'PATCH').map((call) => call.options.body)
const row = (wrapper: any, prefix = 'integration', key = 'nuxt-nitro') =>
  wrapper.get('[data-testid="log-module-row-' + prefix + '-' + key + '"]')
const sheet = (prefix = 'integration', key = 'nuxt-nitro') => {
  const element = document.querySelector(
    '[data-testid="log-module-sheet-' + prefix + '-' + key + '"]'
  )
  if (!element) throw new Error('sheet not mounted: ' + prefix + ':' + key)
  return new DOMWrapper(element)
}
async function openSheet(wrapper: any, prefix = 'integration', key = 'nuxt-nitro') {
  const trigger = row(wrapper, prefix, key)
  if (trigger.attributes('aria-expanded') !== 'true') {
    await trigger.trigger('click')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return sheet(prefix, key)
}
async function closeAnySheet() {
  const done = document.querySelector(
    '[data-testid=log-module-sheet-done]'
  ) as HTMLButtonElement | null
  if (!done) return
  done.click()
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
async function closeSheet(_wrapper: any, _prefix = 'integration', _key = 'nuxt-nitro') {
  await closeAnySheet()
}
const fieldBlock = (profile = 'http') => {
  const element = document.querySelector(
    '[data-testid="log-field-controls-' + profile + '"]'
  )
  if (!element) throw new Error('field block not mounted: ' + profile)
  return new DOMWrapper(element)
}
const byId = (_root: any, id: string) =>
  new DOMWrapper(document.getElementById(id) as Element)
const allSwitch = (wrapper: any, field: string, profile = 'http') =>
  byId(wrapper, 'log-field-' + profile + '-all-' + field)
const levelSwitch = (wrapper: any, field: string, level = 'info', profile = 'http') =>
  byId(wrapper, 'log-field-' + profile + '-' + level + '-' + field)
const state = (wrapper: any, field: string, profile = 'http') =>
  allSwitch(wrapper, field, profile).attributes('data-state')
const mixed = (wrapper: any, field: string, profile = 'http') =>
  allSwitch(wrapper, field, profile).attributes('data-mixed')
const topSummary = (wrapper: any) => wrapper.get('[data-testid=log-unsaved-summary]').text()
async function openAdvanced(_wrapper: any, profile = 'http') {
  await fieldBlock(profile)
    .get('[data-testid="log-field-advanced-' + profile + '"]')
    .trigger('click')
  await flushPromises()
}
async function selectLevel(_wrapper: any, name: string, profile = 'http') {
  const tab = fieldBlock(profile)
    .findAll('[role=tab]')
    .find((entry: any) => entry.attributes('aria-label')?.startsWith(name))
  expect(tab, 'level tab ' + name).toBeTruthy()
  await tab!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
}
async function review(wrapper: any) {
  await closeAnySheet()
  const button = wrapper.get('[data-testid=log-policy-review]')
  expect((button.element as HTMLButtonElement).disabled).toBe(false)
  await button.trigger('click')
  await flushPromises()
  return document.querySelector('[role=dialog]')!
}
async function confirm() {
  ;(document.querySelector('[data-testid=log-policy-confirm]') as HTMLButtonElement).click()
  await flushPromises()
}
async function cancel() {
  ;(
    Array.from(document.querySelectorAll('[role=dialog] button')).find(
      (button) => button.textContent === '取消'
    ) as HTMLButtonElement
  ).click()
  await flushPromises()
}

it('hides the whole field entry when the backend publishes no profile catalog or no effective rules', async () => {
  const missingProfiles = basePolicy({ catalog: { integrations: integrationCatalog } })
  const first = await mountManagement(() => missingProfiles)
  expect(first.wrapper.find('[data-testid^=log-field-controls]').exists()).toBe(false)
  expect(first.wrapper.text()).not.toContain('详情字段（高级）')

  const missingControls = basePolicy({ fieldControls: undefined })
  const second = await mountManagement(() => missingControls)
  expect(second.wrapper.find('[data-testid^=log-field-controls]').exists()).toBe(false)

  // 没有 collection 就无法判断“当前是否采集”，入口同样隐藏。
  const noCollection = basePolicy({ collection: undefined })
  const secondB = await mountManagement(() => noCollection)
  expect(secondB.wrapper.find('[data-testid^=log-field-controls]').exists()).toBe(false)
  expect(secondB.wrapper.find('[data-testid=log-module-row-integration-nuxt-nitro]').exists()).toBe(false)

  // Structurally incomplete controls from a broken backend must not be filled in locally.
  const incomplete = basePolicy()
  const incompleteControls = incomplete.fieldControls as unknown as Record<
    string,
    Record<string, Record<string, boolean>>
  >
  delete incompleteControls.http!.info!.httpRoute
  const third = await mountManagement(() => incomplete)
  expect(third.wrapper.find('[data-testid^=log-field-controls]').exists()).toBe(false)
  // 没有用本地常量补出字段开关：页面只保留真实目录里已有的采集规则。
  expect(third.wrapper.findAll('[id^=log-field-]')).toHaveLength(0)
  const thirdSheet = await openSheet(third.wrapper, 'integration', 'nuxt-nitro')
  expect(thirdSheet.text()).toContain('字段目录来自服务端')
  expect(third.wrapper.find('[data-testid^=log-field-controls]').exists()).toBe(false)
  vi.unstubAllGlobals()
})

it('lists the module index and opens one drawer at a time without inline controls', async () => {
  const { wrapper } = await mountManagement(() => basePolicy())
  expect(wrapper.text()).not.toContain('详情字段（高级）')
  expect(wrapper.findAll('[data-testid^=log-module-row-]').length).toBeGreaterThanOrEqual(8)
  // 主列表只做索引：开关/下拉都在抽屉里，默认没有任何内联控件。
  expect(document.querySelector('[data-slot=switch]')).toBeNull()
  for (const entry of wrapper.findAll('[data-testid^=log-module-row-]'))
    expect(entry.findAll('[data-slot=switch]')).toHaveLength(0)
  expect(wrapper.find('[data-testid="log-field-controls-http"]').exists()).toBe(false)

  const httpRow = row(wrapper, 'integration', 'nuxt-nitro')
  expect(httpRow.text()).toContain('Nuxt / Nitro 请求')
  expect(httpRow.get('[data-testid=log-module-chevron]').find('.icon-stub').attributes('data-icon')).toBe('lucide:chevron-right')
  expect(httpRow.attributes('aria-expanded')).toBe('false')

  // 点行打开 HTTP 抽屉；标题、字段和状态都在抽屉里。
  const httpSheet = await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(httpSheet.text()).toContain('Nuxt / Nitro 请求')
  expect(httpRow.attributes('aria-expanded')).toBe('true')
  expect(document.querySelector('[data-testid="log-field-controls-http"]')).not.toBeNull()

  // 关闭后回到索引，焦点归还给入口；再开 TUS 不会留下两个抽屉。
  await closeSheet(wrapper, 'integration', 'nuxt-nitro')
  await flushPromises()
  expect(httpRow.attributes('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(httpRow.element)
  await openSheet(wrapper, 'integration', 'tus')
  expect(document.querySelector('[data-testid="log-field-controls-tus"]')).not.toBeNull()
  expect(row(wrapper, 'integration', 'tus').attributes('aria-expanded')).toBe('true')
})

it('keeps every expand chevron pointing right with no rotate class, before and after opening', async () => {
  const { wrapper } = await mountManagement(() => basePolicy())
  const chevron = () =>
    row(wrapper, 'integration', 'nuxt-nitro').get('[data-testid=log-module-chevron]')
  const before = chevron()
  expect(before.find('.icon-stub').attributes('data-icon')).toBe('lucide:chevron-right')
  expect(before.classes().join(' ')).not.toContain('rotate')

  await closeSheet(wrapper, 'integration', 'nuxt-nitro')
  const closed = chevron()
  expect(closed.find('.icon-stub').attributes('data-icon')).toBe('lucide:chevron-right')
  expect(closed.classes().join(' ')).not.toContain('rotate')

  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  const reopened = chevron()
  expect(reopened.find('.icon-stub').attributes('data-icon')).toBe('lucide:chevron-right')
  expect(reopened.classes().join(' ')).not.toContain('rotate')
  expect(row(wrapper, 'integration', 'nuxt-nitro').attributes('aria-expanded')).toBe('true')
})

it('renders exactly the catalog fields and syncs one selection to all event levels by default', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  const panel = fieldBlock('http')
  // Default mode has no level tabs; one switch per real field comes from the catalog.
  expect(panel.findAll('[role=tab]')).toHaveLength(0)
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(HTTP_FIELDS.length)
  expect(panel.findAll('input[type=checkbox]')).toHaveLength(0)
  expect(panel.findAll('select')).toHaveLength(0)
  expect(panel.findAll('details')).toHaveLength(0)
  for (const field of profileCatalog()[0]!.fields) expect(panel.text()).toContain(field.label)
  expect(panel.text()).toContain('（毫秒）')
  expect(panel.text()).toContain('一份选择适用于全部事件级别')
  expect(panel.text()).toContain('各级别均保留全部字段。')
  // HTTP truthfulness: only the four real fields; params/response are not drawn.
  expect(panel.text()).toContain('请求参数、响应内容、原始报文尚未采集')
  expect(panel.text()).toContain('HTTP 完成事件只有 信息 / 警告 / 错误，没有调试档')
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(4)

  expect(state(wrapper, 'httpRoute')).toBe('checked')
  await allSwitch(wrapper, 'httpRoute').trigger('click')
  expect(state(wrapper, 'httpRoute')).toBe('unchecked')
  // The single selection applied to every level.
  await openAdvanced(wrapper)
  expect(panel.findAll('[role=tab]')).toHaveLength(4)
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(4)
  expect(levelSwitch(wrapper, 'httpRoute', 'info').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '调试')
  expect(levelSwitch(wrapper, 'httpRoute', 'debug').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '警告')
  expect(levelSwitch(wrapper, 'httpRoute', 'warn').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '错误')
  expect(levelSwitch(wrapper, 'httpRoute', 'error').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '信息')
  const infoTab = panel
    .findAll('[role=tab]')
    .find((tab: any) => tab.attributes('aria-label')?.startsWith('信息'))!
  expect(infoTab.attributes('aria-label')).toBe('信息，已调整 1 项')
  expect(topSummary(wrapper)).toContain('未保存：Nuxt / Nitro 请求')
  expect(row(wrapper, 'integration', 'nuxt-nitro').text()).toContain('详情 3/4 项')
  expect(patches(calls)).toHaveLength(0)

  // Collapsing keeps the draft and the panel-header summary; reopening shows it again.
  await closeSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(wrapper.find('[data-testid="log-field-controls-http"]').exists()).toBe(false)
  expect(row(wrapper, 'integration', 'nuxt-nitro').text()).toContain('未保存')
  expect(row(wrapper, 'integration', 'nuxt-nitro').text()).toContain('详情 3/4 项')
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(state(wrapper, 'httpRoute')).toBe('unchecked')
})

it('shows a saved mixed state without overwriting it, and only syncs when the field is changed', async () => {
  const { wrapper, calls } = await mountManagement(() =>
    basePolicy({ fieldControls: controlsWith('info', { httpRoute: false }) })
  )
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(mixed(wrapper, 'httpRoute')).toBe('true')
  expect(fieldBlock('http').text()).toContain('各级别不一致')
  expect(fieldBlock('http').text()).toContain(
    '已保存的各事件级别不一致：改动某个字段会把该字段同步到全部级别。'
  )
  // Merely reading the mixed state writes nothing.
  expect(patches(calls)).toHaveLength(0)

  await allSwitch(wrapper, 'httpRoute').trigger('click')
  expect(mixed(wrapper, 'httpRoute')).toBeUndefined()
  expect(state(wrapper, 'httpRoute')).toBe('checked')
  // All levels are now true; only the one saved false is a real diff.
  await review(wrapper)
  const table = document.querySelector('[data-testid=log-field-review-table]')!
  expect(table.textContent).toContain('HTTP 请求 · 信息 · 路由模板')
  expect(table.textContent).toContain('保留')
  await cancel()
  expect(patches(calls)).toHaveLength(0)
})

it('keeps the advanced mode UI-only and edits each event level independently', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  await openAdvanced(wrapper)
  // Opening the advanced mode alone is not a data change.
  expect(patches(calls)).toHaveLength(0)
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('checked')

  await levelSwitch(wrapper, 'httpMethod', 'info').trigger('click')
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '警告')
  expect(levelSwitch(wrapper, 'httpMethod', 'warn').attributes('data-state')).toBe('checked')

  await selectLevel(wrapper, '信息')
  await levelSwitch(wrapper, 'httpMethod', 'info').trigger('click')
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('checked')
  expect(patches(calls)).toHaveLength(0)
})

it('keeps parents untouched and still saves field preferences while the source is off', async () => {
  let current: Record<string, unknown> = basePolicy()
  ;(current.collection as any).sources.http = rule({ enabled: false, minLevel: 'warn' })
  const { wrapper, calls } = await mountManagement(
    () => current,
    (body) => {
      const next = basePolicy()
      ;(next.collection as any).sources.http = rule({ enabled: false, minLevel: 'warn' })
      next.fieldControls = body.fieldControls ? defaultControls() : next.fieldControls
      ;(next.fieldControls as any).http.info.durationMs = false
      ;(next.fieldControls as any).http.debug.durationMs = false
      ;(next.fieldControls as any).http.warn.durationMs = false
      ;(next.fieldControls as any).http.error.durationMs = false
      next.revision = 2
      current = next
      return next
    }
  )
  const panel = await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(panel.text()).toContain('当前不采集')
  expect(panel.text()).toContain('HTTP 接口来源已关闭')
  expect(panel.text()).toContain('选择会保留')
  // 父级关闭不影响字段开关和草稿保存。
  expect((allSwitch(wrapper, 'durationMs').element as HTMLElement).hasAttribute('disabled')).toBe(false)
  await allSwitch(wrapper, 'durationMs').trigger('click')
  await openAdvanced(wrapper)
  expect(fieldBlock('http').text()).toContain(
    '低于采集门槛「警告」'
  )
  await review(wrapper)
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: {
        http: {
          debug: { durationMs: false },
          info: { durationMs: false },
          warn: { durationMs: false },
          error: { durationMs: false }
        }
      }
    }
  ])
  // 保存不会顺手重新打开来源，也不会把父级规则塞进这次 PATCH。
  expect((current.collection as any).sources.http.enabled).toBe(false)
  expect(patches(calls)[0]).not.toHaveProperty('collection')
  expect(wrapper.text()).toContain('日志配置已保存。')
})

it('copies to sibling levels, restores this level and undoes both as draft-only changes', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  await openAdvanced(wrapper)
  await levelSwitch(wrapper, 'httpMethod', 'info').trigger('click')
  await levelSwitch(wrapper, 'statusCode', 'info').trigger('click')
  expect(row(wrapper, 'integration', 'nuxt-nitro').text()).toContain('详情 2/4 项')

  await fieldBlock('http').get('[data-testid=log-field-copy-http]').trigger('click')
  await flushPromises()
  const copyPanel = fieldBlock('http').get('[data-testid=log-field-copy-panel-http]')
  expect(copyPanel.text()).toContain('把这 4 项选择复制到其他级别')
  expect(copyPanel.findAll('input, [data-slot=checkbox]')).toHaveLength(3)
  // 至少选一个目标才允许复制；未复制前仍是 0 次写入。
  expect(
    (fieldBlock('http').get('[data-testid=log-field-copy-apply-http]').element as HTMLButtonElement).disabled
  ).toBe(true)
  expect(patches(calls)).toHaveLength(0)
  await fieldBlock('http').get('[id="log-field-copy-http-warn"]').trigger('click')
  await flushPromises()
  expect(
    (fieldBlock('http').get('[data-testid=log-field-copy-apply-http]').element as HTMLButtonElement).disabled
  ).toBe(false)
  await fieldBlock('http').get('[data-testid=log-field-copy-apply-http]').trigger('click')
  await flushPromises()
  expect(fieldBlock('http').text()).toContain('已复制到警告')
  expect(patches(calls)).toHaveLength(0)

  // 撤销把目标级别恢复成复制前，不动源级别；临时消息随后由级别切换清掉。
  await fieldBlock('http').get('[data-testid=log-field-undo-http]').trigger('click')
  await flushPromises()
  expect(fieldBlock('http').text()).toContain('已撤销')
  await selectLevel(wrapper, '警告')
  expect(levelSwitch(wrapper, 'httpMethod', 'warn').attributes('data-state')).toBe('checked')
  expect(fieldBlock('http').find('[data-testid=log-field-undo-http]').exists()).toBe(false)
  await selectLevel(wrapper, '信息')
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('unchecked')

  // 再做一次复制，确认目标级别真的被覆盖、源级别不受影响。
  await fieldBlock('http').get('[data-testid=log-field-copy-http]').trigger('click')
  await flushPromises()
  await fieldBlock('http').get('[id="log-field-copy-http-warn"]').trigger('click')
  await flushPromises()
  await fieldBlock('http').get('[data-testid=log-field-copy-apply-http]').trigger('click')
  await flushPromises()
  await selectLevel(wrapper, '警告')
  expect(levelSwitch(wrapper, 'httpMethod', 'warn').attributes('data-state')).toBe('unchecked')
  expect(levelSwitch(wrapper, 'statusCode', 'warn').attributes('data-state')).toBe('unchecked')
  await selectLevel(wrapper, '错误')
  expect(levelSwitch(wrapper, 'httpMethod', 'error').attributes('data-state')).toBe('checked')

  // 恢复本级别默认只恢复当前档；可撤销。
  await selectLevel(wrapper, '信息')
  await fieldBlock('http').get('[data-testid=log-field-restore-http]').trigger('click')
  await flushPromises()
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('checked')
  expect(levelSwitch(wrapper, 'statusCode', 'info').attributes('data-state')).toBe('checked')
  expect(fieldBlock('http').text()).toContain('已恢复本级别的默认选择')
  expect(patches(calls)).toHaveLength(0)
  await fieldBlock('http').get('[data-testid=log-field-undo-http]').trigger('click')
  await flushPromises()
  expect(levelSwitch(wrapper, 'httpMethod', 'info').attributes('data-state')).toBe('unchecked')
  expect(levelSwitch(wrapper, 'statusCode', 'info').attributes('data-state')).toBe('unchecked')
})

it('reviews only real diffs against the server baseline, including restoring a saved false', async () => {
  let current: Record<string, unknown> = basePolicy({
    fieldControls: controlsWith('info', { httpRoute: false, statusCode: false }),
    revision: 3
  })
  const { wrapper, calls } = await mountManagement(
    () => current,
    (body) => {
      const next = basePolicy({
        fieldControls: controlsWith('info', { httpRoute: true, statusCode: false }),
        revision: 4
      })
      current = next
      return next
    }
  )
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(mixed(wrapper, 'httpRoute')).toBe('true')
  await allSwitch(wrapper, 'httpRoute').trigger('click')
  const dialog = await review(wrapper)
  const table = dialog.querySelector('[data-testid=log-field-review-table]')!
  expect(table.textContent).toContain('HTTP 请求 · 信息 · 路由模板')
  expect(table.textContent).toContain('不记录')
  expect(table.textContent).toContain('保留')
  // 未改动的 statusCode 不列入核对。
  expect(table.textContent).not.toContain('响应状态')
  expect(dialog.textContent).toContain('恢复为保留也会作为改动提交')
  await cancel()
  expect(patches(calls)).toHaveLength(0)
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(state(wrapper, 'httpRoute')).toBe('checked')

  await review(wrapper)
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: { http: { info: { httpRoute: true } } }
    }
  ])
  // 成功响应回填草稿并保留展开、类型和级别。
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  expect(state(wrapper, 'httpRoute')).toBe('checked')
  expect(mixed(wrapper, 'statusCode')).toBe('true')
  expect(row(wrapper, 'integration', 'nuxt-nitro').text()).toContain('Nuxt / Nitro 请求')
  expect(fieldBlock('http').findAll('[data-slot=switch]')).toHaveLength(4)
})

it('keeps the draft after a 409 or a generic failure and never reports the change as saved', async () => {
  for (const code of ['policy_capacity_pending', 'logging_unavailable']) {
    const { wrapper, calls } = await mountManagement(
      () => basePolicy(),
      () => {
        throw { data: { error: { code } } }
      }
    )
    await openSheet(wrapper, 'integration', 'nuxt-nitro')
    await allSwitch(wrapper, 'durationMs').trigger('click')
    await review(wrapper)
    await confirm()
    expect(patches(calls)).toHaveLength(1)
    expect(wrapper.text()).not.toContain('日志配置已保存')
    expect(wrapper.text()).toContain(code === 'policy_capacity_pending' ? '原策略仍生效' : '日志服务暂不可用')
    // 草稿与展开状态都还在，重复提交不会重复计为已保存。
    await openSheet(wrapper, 'integration', 'nuxt-nitro')
    expect(state(wrapper, 'durationMs')).toBe('unchecked')
    expect(topSummary(wrapper)).toContain('未保存：Nuxt / Nitro 请求')
    expect(fieldBlock('http').text()).toContain('详情 3/4 项')
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    vi.unstubAllGlobals()
  }
})

it('switches to the real TUS profile and PATCHes its dotted field keys verbatim', async () => {
  const { wrapper, calls } = await mountManagement(
    () => basePolicy(),
    (body) => basePolicy({ fieldControls: body.fieldControls, revision: 2 })
  )
  await openSheet(wrapper, 'integration', 'tus')
  const panel = fieldBlock('tus')
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(4)
  // 嵌套键原样成为 DOM id 与提交键，不被拆成 tus → uploadId。
  for (const key of TUS_FIELDS) expect(document.getElementById('log-field-tus-all-' + key)).not.toBeNull()
  await byId(wrapper, 'log-field-tus-all-tus.uploadId').trigger('click')
  await review(wrapper)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.querySelector('[data-testid=log-field-review-table]')!.textContent).toContain(
    'TUS 上传 · 信息 · ' + label('tus', 'tus.uploadId')
  )
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: {
        tus: {
          debug: { 'tus.uploadId': false },
          info: { 'tus.uploadId': false },
          warn: { 'tus.uploadId': false },
          error: { 'tus.uploadId': false }
        }
      }
    }
  ])
  // tus 来源与 tus 集成都在开启状态时，不显示“当前不采集”。
  expect(row(wrapper, 'integration', 'tus').text()).not.toContain('当前不采集')
})

it('marks the real TUS profile as not collecting from file source and tus integration only', async () => {
  const base = basePolicy()
  // 关闭 file 来源，但保持 tus 集成开启；真实 TUS profile 的父级必须同时看这两处。
  ;(base.collection as unknown as Record<string, Record<string, unknown>>).sources!.file = rule({
    enabled: false
  })
  const { wrapper } = await mountManagement(() => base)
  const panel = await openSheet(wrapper, 'integration', 'tus')
  expect(panel.text()).toContain('当前不采集')
  expect(panel.text()).toContain('文件来源已关闭')
  wrapper.unmount()
  wrappers.splice(wrappers.indexOf(wrapper), 1)
  // 只有 tus 集成关闭时同样成立，不会把来源或 tus-client 混进来。
  const integrationOff = basePolicy()
  ;(integrationOff.collection as unknown as Record<string, Record<string, unknown>>).integrations!.tus =
    rule({ enabled: false })
  const second = await mountManagement(() => integrationOff)
  const secondPanel = await openSheet(second.wrapper, 'integration', 'tus')
  expect(secondPanel.text()).toContain('当前不采集')
  expect(secondPanel.text()).toContain('tus 服务端回调集成已关闭')
  expect(secondPanel.text()).not.toContain('tus 客户端')
  // 父级关闭不影响编辑与保存偏好。
  expect(
    (byId(second.wrapper, 'log-field-tus-all-tus.method').element as HTMLElement).hasAttribute(
      'disabled'
    )
  ).toBe(false)
})

it('renders and PATCHes the real service policy catalog without drifting from the backend shape', async () => {
  const service = createLogService({ directory: ownedDirectory() })
  services.push(service)
  const response = await service.policy()
  // The real response is the only thing driving the editor; the test itself
  // never supplies profile, level or field names.
  expect(response.catalog.profiles.map((profile) => profile.key)).toEqual(['http', 'tus'])
  const { wrapper, calls } = await mountManagement(
    () => response as unknown as Record<string, unknown>,
    (body) => ({ ...(response as unknown as Record<string, unknown>), ...body, revision: 2 })
  )
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  const panel = fieldBlock('http')
  const fieldConfig = response.catalog.profiles[0]!
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(fieldConfig.fields.length)
  expect(panel.text()).toContain('各级别均保留全部字段。')
  // Every real field NAME still comes from the catalog; explanations are gone.
  for (const field of fieldConfig.fields) expect(panel.text()).toContain(field.label)
  const target = fieldConfig.fields.find((field) => field.key === 'httpRoute')!
  await allSwitch(wrapper, String(target.key)).trigger('click')
  await review(wrapper)
  expect(
    document.querySelector('[data-testid=log-field-review-table]')!.textContent
  ).toContain(target.label)
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: response.retentionDays,
      maxBytes: response.maxBytes,
      fieldControls: {
        http: {
          debug: { httpRoute: false },
          info: { httpRoute: false },
          warn: { httpRoute: false },
          error: { httpRoute: false }
        }
      }
    }
  ])
  // 第二个 profile 的目录同样来自真实响应，且点开就有四个开关。
  await openSheet(wrapper, 'integration', 'tus')
  const tusConfig = response.catalog.profiles[1]!
  expect(
    fieldBlock('tus').findAll('[data-slot=switch]')
  ).toHaveLength(tusConfig.fields.length)
  for (const field of tusConfig.fields) {
    expect(fieldBlock('tus').text()).toContain(field.label)
  }
  // 单位不在标签里，不能随解释一起删掉。
  expect(fieldBlock('tus').text()).toContain('（字节）')
  // 服务端真的落库后，重新读取的响应仍能被同一份草稿逻辑消化。
  const saved = await service.setPolicy({
    retentionDays: response.retentionDays,
    maxBytes: response.maxBytes,
    fieldControls: { http: { info: { httpRoute: false } } }
  })
  expect(saved.fieldControls.http.info).toMatchObject({ httpRoute: false, statusCode: true })
  const reopened = createLogService({ directory: directories[0]! })
  services.push(reopened)
  const persisted = await reopened.policy()
  expect(persisted.fieldControls).toEqual(saved.fieldControls)
  expect(persisted.catalog.profiles).toEqual(response.catalog.profiles)
})

it('sends no fieldControls at all when the field draft is untouched', async () => {
  const { wrapper, calls } = await mountManagement(
    () => basePolicy(),
    () => basePolicy({ retentionDays: 8 })
  )
  // 默认全保留且没有改字段：即使是完整的字段目录，PATCH 也不带 fieldControls。
  await wrapper.get('#log-retention-days').setValue('8')
  await review(wrapper)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.querySelector('[data-testid=log-field-review-table]')).toBeNull()
  await confirm()
  expect(patches(calls)).toEqual([{ retentionDays: 8, maxBytes: 536870912 }])
  expect(patches(calls)[0]).not.toHaveProperty('fieldControls')
})

it('offers no review until a field actually differs from the saved rules', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openSheet(wrapper, 'integration', 'nuxt-nitro')
  const reviewButton = wrapper.get('[data-testid=log-policy-review]')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(true)
  expect(wrapper.text()).toContain('当前配置与已生效配置相同')
  await allSwitch(wrapper, 'httpMethod').trigger('click')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(false)
  await allSwitch(wrapper, 'httpMethod').trigger('click')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(true)
  expect(patches(calls)).toHaveLength(0)
})

it('shows a follow note instead of fake field switches on source rows', async () => {
  const { wrapper } = await mountManagement(() => basePolicy())
  const sourcePanel = await openSheet(wrapper, 'source', 'http')
  expect(sourcePanel.text()).toContain('此来源暂无独立的字段采集选项')
  expect(sourcePanel.text()).toContain('字段跟随「Nuxt / Nitro 请求」')
  expect(sourcePanel.findAll('[data-slot=switch]')).toHaveLength(1)
  expect(sourcePanel.findAll('[data-testid^=log-field-controls]')).toHaveLength(0)

  await closeSheet(wrapper, 'source', 'http')
  const taskPanel = await openSheet(wrapper, 'source', 'task')
  expect(taskPanel.text()).toContain('暂无字段采集选项')
})
