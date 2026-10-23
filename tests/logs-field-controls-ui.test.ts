// @vitest-environment happy-dom
// Component seam only: proves the configuration UI's draft/PATCH contract in
// happy-dom, not real browser behaviour. One case mounts the component with a
// real service policy response so the rendered catalog cannot drift from the
// backend shape without a failing test. Desktop and 390px operation stays a
// separate manual acceptance lane.
import { mount, flushPromises } from '@vue/test-utils'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LogFieldControls, LogFieldControlsPatch } from '../lib/logging/contract'
import { LOG_FIELD_PROFILES } from '../lib/logging/field-controls'
import { createLogService } from '../lib/logging/service'

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
const tusControlsWith = (level: TestLevel, overrides: Partial<Record<string, boolean>>) => {
  const controls = defaultControls() as unknown as Record<
    string,
    Record<TestLevel, Record<string, boolean>>
  >
  Object.assign(controls.tus![level], overrides)
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
  const { default: Management } = await import('../components/logs/LogManagement.vue')
  const wrapper = mount(Management, { props: { filter: {} }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, calls }
}
const patches = (calls: { options: any }[]) =>
  calls.filter((call) => call.options?.method === 'PATCH').map((call) => call.options.body)
async function openPanel(wrapper: any) {
  const trigger = wrapper
    .findAll('button')
    .find((button: any) => button.text().includes('详情字段（高级）'))
  expect(trigger, 'field entry must be rendered').toBeTruthy()
  await trigger!.trigger('click')
  await flushPromises()
}
/** TUS keys contain dots, so an #id selector would be parsed as a class. */
const byId = (root: any, id: string) => root.get(`[id="${id}"]`)
const fieldSwitch = (wrapper: any, field: string, level = 'info', profile = 'http') =>
  byId(wrapper, `log-field-${profile}-${level}-${field}`)
const state = (wrapper: any, field: string, level = 'info') =>
  fieldSwitch(wrapper, field, level).attributes('data-state')
async function selectLevel(wrapper: any, label: string) {
  const tab = wrapper
    .findAll('[role=tab]')
    .find((entry: any) => entry.attributes('aria-label')?.startsWith(label))
  expect(tab, `level tab ${label}`).toBeTruthy()
  await tab!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
}
async function review(wrapper: any) {
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
  expect(first.wrapper.find('[data-testid=log-field-controls]').exists()).toBe(false)
  expect(first.wrapper.text()).not.toContain('详情字段（高级）')

  const missingControls = basePolicy({ fieldControls: undefined })
  const second = await mountManagement(() => missingControls)
  expect(second.wrapper.find('[data-testid=log-field-controls]').exists()).toBe(false)

  // 没有 collection 就无法判断“当前是否采集”，入口同样隐藏。
  const noCollection = basePolicy({ collection: undefined })
  const secondB = await mountManagement(() => noCollection)
  expect(secondB.wrapper.find('[data-testid=log-field-controls]').exists()).toBe(false)

  // Structurally incomplete controls from a broken backend must not be filled in locally.
  const incomplete = basePolicy()
  const incompleteControls = incomplete.fieldControls as unknown as Record<
    string,
    Record<string, Record<string, boolean>>
  >
  delete incompleteControls.http!.info!.httpRoute
  const third = await mountManagement(() => incomplete)
  expect(third.wrapper.find('[data-testid=log-field-controls]').exists()).toBe(false)
  // 没有用本地常量补出字段开关：页面只保留真实目录里已有的采集规则。
  expect(third.wrapper.findAll('[id^=log-field-]')).toHaveLength(0)
  vi.unstubAllGlobals()
})

it('renders exactly the catalog profiles and levels, one level at a time, without writing', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openPanel(wrapper)
  const panel = wrapper.get('[data-testid=log-field-controls]')
  // 两个已实施 profile 与来自目录的四个级别；不是本地常量拼出来的矩阵。
  const tabs = panel.findAll('[role=tab]')
  expect(tabs).toHaveLength(6)
  expect(tabs.slice(0, 2).map((tab: any) => tab.text())).toEqual(['HTTP 请求', 'TUS 上传'])
  expect(tabs.slice(2).map((tab: any) => tab.text())).toEqual(['调试', '信息', '警告', '错误'])
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(4)
  expect(panel.findAll('input[type=checkbox]')).toHaveLength(0)
  expect(panel.findAll('select')).toHaveLength(0)
  expect(panel.findAll('details')).toHaveLength(0)
  // 字段名仍来自目录；只有单位（毫秒/字节）作为后缀保留，不再逐条铺解释。
  for (const field of profileCatalog()[0]!.fields) expect(panel.text()).toContain(field.label)
  expect(panel.text()).toContain('（毫秒）')
  // 默认全 true 时，状态句必须如实说明「所有级别都保留全部字段」；
  // 旧文案「部分级别已改」与这个分支的事实相反，这里锁死回归。
  expect(panel.text()).toContain('各级别均保留全部字段。')
  expect(panel.text()).not.toContain('部分级别已改')

  expect(state(wrapper, 'httpRoute')).toBe('checked')
  await fieldSwitch(wrapper, 'httpRoute').trigger('click')
  expect(state(wrapper, 'httpRoute')).toBe('unchecked')
  // 切换级别不丢草稿，级别 tab 用可访问名称报告改动数。
  await selectLevel(wrapper, '错误')
  expect(wrapper.findAll('[data-testid=log-field-controls] [data-slot=switch]')).toHaveLength(4)
  expect(state(wrapper, 'httpRoute', 'error')).toBe('checked')
  await selectLevel(wrapper, '信息')
  expect(state(wrapper, 'httpRoute')).toBe('unchecked')
  const infoTab = wrapper
    .findAll('[role=tab]')
    .find((tab: any) => tab.attributes('aria-label')?.startsWith('信息'))!
  expect(infoTab.attributes('aria-label')).toBe('信息，已调整 1 项')
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('共 1 项未保存')
  expect(patches(calls)).toHaveLength(0)
  // 收起后草稿和当前类型/级别都保留，标题旁的状态继续可见。
  const trigger = wrapper
    .findAll('button')
    .find((button: any) => button.text().includes('详情字段（高级）'))!
  await trigger.trigger('click')
  await flushPromises()
  expect(wrapper.findAll('[data-testid=log-field-controls] [data-slot=switch]')).toHaveLength(0)
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('共 1 项未保存')
  await trigger.trigger('click')
  await flushPromises()
  expect(state(wrapper, 'httpRoute')).toBe('unchecked')
})

it('keeps parents untouched and still saves field preferences while the source is off', async () => {
  let current: Record<string, unknown> = basePolicy()
  ;(current.collection as any).sources.http = rule({ enabled: false, minLevel: 'warn' })
  const { wrapper, calls } = await mountManagement(
    () => current,
    (body) => {
      const next = basePolicy()
      ;(next.collection as any).sources.http = rule({ enabled: false, minLevel: 'warn' })
      next.fieldControls = body.fieldControls ? controlsWith('info', { durationMs: false }) : next.fieldControls
      next.revision = 2
      current = next
      return next
    }
  )
  await openPanel(wrapper)
  const panel = wrapper.get('[data-testid=log-field-controls]')
  expect(panel.text()).toContain('当前不采集')
  expect(panel.text()).toContain('HTTP 接口来源已关闭')
  expect(panel.text()).toContain('选择会保留')
  expect(panel.text()).toContain('低于最低级别警告')
  // 父级关闭不影响字段开关和草稿保存。
  expect((fieldSwitch(wrapper, 'durationMs').element as HTMLElement).hasAttribute('disabled')).toBe(false)
  await fieldSwitch(wrapper, 'durationMs').trigger('click')
  await review(wrapper)
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: { http: { info: { durationMs: false } } }
    }
  ])
  // 保存不会顺手重新打开来源，也不会把父级规则塞进这次 PATCH。
  expect((current.collection as any).sources.http.enabled).toBe(false)
  expect(patches(calls)[0]).not.toHaveProperty('collection')
  expect(wrapper.text()).toContain('日志配置已保存。')
})

it('copies to sibling levels, restores this level and undoes both as draft-only changes', async () => {
  const { wrapper, calls } = await mountManagement(() => basePolicy())
  await openPanel(wrapper)
  await fieldSwitch(wrapper, 'httpMethod').trigger('click')
  await fieldSwitch(wrapper, 'statusCode').trigger('click')
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('共 2 项未保存')

  await wrapper.get('[data-testid=log-field-copy]').trigger('click')
  await flushPromises()
  const targets = wrapper.findAll('[data-testid=log-field-copy-panel] input, [data-slot=checkbox]')
  expect(wrapper.get('[data-testid=log-field-copy-panel]').text()).toContain('把这 4 项选择复制到其他级别')
  expect(targets).toHaveLength(3)
  // 至少选一个目标才允许复制；未复制前仍是 0 次写入。
  expect((wrapper.get('[data-testid=log-field-copy-apply]').element as HTMLButtonElement).disabled).toBe(true)
  expect(patches(calls)).toHaveLength(0)
  await wrapper.get('#log-field-copy-warn').trigger('click')
  await flushPromises()
  expect((wrapper.get('[data-testid=log-field-copy-apply]').element as HTMLButtonElement).disabled).toBe(false)
  await wrapper.get('[data-testid=log-field-copy-apply]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('已复制到警告')
  expect(patches(calls)).toHaveLength(0)

  // 撤销把目标级别恢复成复制前，不动源级别；临时消息随后由级别切换清掉。
  await wrapper.get('[data-testid=log-field-undo]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('已撤销')
  await selectLevel(wrapper, '警告')
  expect(state(wrapper, 'httpMethod', 'warn')).toBe('checked')
  expect(wrapper.find('[data-testid=log-field-undo]').exists()).toBe(false)
  await selectLevel(wrapper, '信息')
  expect(state(wrapper, 'httpMethod')).toBe('unchecked')

  // 再做一次复制，确认目标级别真的被覆盖、源级别不受影响。
  await wrapper.get('[data-testid=log-field-copy]').trigger('click')
  await flushPromises()
  await wrapper.get('#log-field-copy-warn').trigger('click')
  await flushPromises()
  await wrapper.get('[data-testid=log-field-copy-apply]').trigger('click')
  await flushPromises()
  await selectLevel(wrapper, '警告')
  expect(state(wrapper, 'httpMethod', 'warn')).toBe('unchecked')
  expect(state(wrapper, 'statusCode', 'warn')).toBe('unchecked')
  await selectLevel(wrapper, '错误')
  expect(state(wrapper, 'httpMethod', 'error')).toBe('checked')

  // 恢复本级别默认只恢复当前档；可撤销。
  await selectLevel(wrapper, '信息')
  await wrapper.get('[data-testid=log-field-restore]').trigger('click')
  await flushPromises()
  expect(state(wrapper, 'httpMethod')).toBe('checked')
  expect(state(wrapper, 'statusCode')).toBe('checked')
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('已恢复本级别的默认选择')
  expect(patches(calls)).toHaveLength(0)
  await wrapper.get('[data-testid=log-field-undo]').trigger('click')
  await flushPromises()
  expect(state(wrapper, 'httpMethod')).toBe('unchecked')
  expect(state(wrapper, 'statusCode')).toBe('unchecked')
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
  await openPanel(wrapper)
  await fieldSwitch(wrapper, 'httpRoute').trigger('click')
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
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('当前 1 项不记录')
  expect(state(wrapper, 'httpRoute')).toBe('checked')
  expect(state(wrapper, 'statusCode')).toBe('unchecked')
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('HTTP 请求')
  expect(wrapper.findAll('[data-testid=log-field-controls] [data-slot=switch]')).toHaveLength(4)
})

it('keeps the draft after a 409 or a generic failure and never reports the change as saved', async () => {
  for (const code of ['policy_capacity_pending', 'logging_unavailable']) {
    const { wrapper, calls } = await mountManagement(
      () => basePolicy(),
      () => {
        throw { data: { error: { code } } }
      }
    )
    await openPanel(wrapper)
    await fieldSwitch(wrapper, 'durationMs').trigger('click')
    await review(wrapper)
    await confirm()
    expect(patches(calls)).toHaveLength(1)
    expect(wrapper.text()).not.toContain('日志配置已保存')
    expect(wrapper.text()).toContain(code === 'policy_capacity_pending' ? '原策略仍生效' : '日志服务暂不可用')
    // 草稿与展开状态都还在，重复提交不会重复计为已保存。
    expect(state(wrapper, 'durationMs')).toBe('unchecked')
    expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('共 1 项未保存')
    vi.unstubAllGlobals()
  }
})

it('switches to the real TUS profile and PATCHes its dotted field keys verbatim', async () => {
  const { wrapper, calls } = await mountManagement(
    () => basePolicy(),
    (body) => basePolicy({ fieldControls: body.fieldControls, revision: 2 })
  )
  await openPanel(wrapper)
  const tabs = wrapper.get('[data-testid=log-field-controls]').findAll('[role=tab]')
  expect(tabs.slice(0, 2).map((tab: any) => tab.text())).toEqual(['HTTP 请求', 'TUS 上传'])
  await tabs[1]!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const switches = wrapper.get('[data-testid=log-field-controls]').findAll('[data-slot=switch]')
  expect(switches).toHaveLength(4)
  // 嵌套键原样成为 DOM id 与提交键，不被拆成 tus → uploadId。
  for (const key of TUS_FIELDS) expect(document.getElementById(`log-field-tus-info-${key}`)).not.toBeNull()
  await byId(wrapper, 'log-field-tus-info-tus.uploadId').trigger('click')
  await review(wrapper)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.querySelector('[data-testid=log-field-review-table]')!.textContent).toContain(
    `TUS 上传 · 信息 · ${label('tus', 'tus.uploadId')}`
  )
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: { tus: { info: { 'tus.uploadId': false } } }
    }
  ])
  // tus 来源与 tus 集成都在开启状态时，不显示“当前不采集”。
  expect(wrapper.get('[data-testid=log-field-controls]').text()).not.toContain('当前不采集')
})

it('marks the real TUS profile as not collecting from file source and tus integration only', async () => {
  const base = basePolicy()
  // 关闭 file 来源，但保持 tus 集成开启；真实 TUS profile 的父级必须同时看这两处。
  ;(base.collection as unknown as Record<string, Record<string, unknown>>).sources!.file = rule({
    enabled: false
  })
  const { wrapper } = await mountManagement(() => base)
  await openPanel(wrapper)
  await wrapper
    .get('[data-testid=log-field-controls]')
    .findAll('[role=tab]')[1]!
    .trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const panel = wrapper.get('[data-testid=log-field-controls]')
  expect(panel.text()).toContain('当前不采集')
  expect(panel.text()).toContain('文件来源已关闭')
  // 只有 tus 集成关闭时同样成立，不会把来源或 tus-client 混进来。
  const integrationOff = basePolicy()
  ;(integrationOff.collection as unknown as Record<string, Record<string, unknown>>).integrations!.tus =
    rule({ enabled: false })
  const second = await mountManagement(() => integrationOff)
  await openPanel(second.wrapper)
  await second.wrapper
    .get('[data-testid=log-field-controls]')
    .findAll('[role=tab]')[1]!
    .trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const secondPanel = second.wrapper.get('[data-testid=log-field-controls]')
  expect(secondPanel.text()).toContain('当前不采集')
  expect(secondPanel.text()).toContain('tus 服务端回调集成已关闭')
  expect(secondPanel.text()).not.toContain('tus 客户端')
  // 父级关闭不影响编辑与保存偏好。
  expect(
    (byId(second.wrapper, 'log-field-tus-info-tus.method').element as HTMLElement).hasAttribute(
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
  await openPanel(wrapper)
  const tabs = wrapper.get('[data-testid=log-field-controls]').findAll('[role=tab]')
  expect(tabs.slice(0, 2).map((tab: any) => tab.text())).toEqual(
    response.catalog.profiles.map((profile) => profile.label)
  )
  expect(tabs.slice(2).map((tab: any) => tab.text())).toEqual(
    response.catalog.profiles[0]!.levels.map((level) => LEVEL_LABELS[level])
  )
  const fieldConfig = response.catalog.profiles[0]!
  const switches = wrapper.get('[data-testid=log-field-controls]').findAll('[data-slot=switch]')
  expect(switches).toHaveLength(fieldConfig.fields.length)
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('各级别均保留全部字段。')
  // Every real field NAME still comes from the catalog; explanations are gone.
  for (const field of fieldConfig.fields) {
    expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain(field.label)
  }
  const target = fieldConfig.fields.find((field) => field.key === 'httpRoute')!
  await fieldSwitch(wrapper, String(target.key)).trigger('click')
  await review(wrapper)
  expect(
    document.querySelector('[data-testid=log-field-review-table]')!.textContent
  ).toContain(target.label)
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: response.retentionDays,
      maxBytes: response.maxBytes,
      fieldControls: { http: { info: { httpRoute: false } } }
    }
  ])
  // 第二个 profile 的目录同样来自真实响应，且点开就有四个开关。
  await tabs[1]!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const tusConfig = response.catalog.profiles[1]!
  expect(
    wrapper.get('[data-testid=log-field-controls]').findAll('[data-slot=switch]')
  ).toHaveLength(tusConfig.fields.length)
  for (const field of tusConfig.fields) {
    expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain(field.label)
  }
  // 单位不在标签里，不能随解释一起删掉。
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('（字节）')
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
  await openPanel(wrapper)
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
  await openPanel(wrapper)
  const reviewButton = wrapper.get('[data-testid=log-policy-review]')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(true)
  expect(wrapper.text()).toContain('当前配置与已生效配置相同')
  await fieldSwitch(wrapper, 'httpMethod').trigger('click')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(false)
  await fieldSwitch(wrapper, 'httpMethod').trigger('click')
  expect((reviewButton.element as HTMLButtonElement).disabled).toBe(true)
  expect(patches(calls)).toHaveLength(0)
})
