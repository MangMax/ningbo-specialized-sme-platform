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
/** Server catalog fixture: only the implemented HTTP profile, exactly four fields. */
const profileCatalog = () => [
  {
    key: 'http',
    source: 'http',
    label: 'HTTP 请求',
    levels: [...LEVELS],
    fields: [
      { key: 'httpMethod', label: '请求方法', description: '服务端已知的请求方法' },
      { key: 'httpRoute', label: '路由模板', description: '框架匹配或应用定义的固定模板' },
      { key: 'statusCode', label: '响应状态', description: '响应的 HTTP 状态码' },
      { key: 'durationMs', label: '耗时', description: '请求耗时，单位毫秒' }
    ]
  }
]
const FIELD_KEYS = ['httpMethod', 'httpRoute', 'statusCode', 'durationMs'] as const
type TestControls = Record<string, Record<TestLevel, Record<string, boolean>>>
const defaultControls = () =>
  ({
    http: Object.fromEntries(
      LEVELS.map((level) => [level, Object.fromEntries(FIELD_KEYS.map((key) => [key, true]))])
    )
  }) as unknown as TestControls
const controlsWith = (
  level: TestLevel,
  overrides: Partial<Record<(typeof FIELD_KEYS)[number], boolean>>
) => {
  const controls = defaultControls()
  Object.assign(controls.http![level], overrides)
  return controls
}
const integrationCatalog = [
  { key: 'nuxt-nitro', label: 'Nuxt / Nitro 请求', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'mcp-toolkit', label: 'MCP Toolkit 模块上下文', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'tus', label: 'tus 服务端回调', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'application', label: '应用手动埋点', state: 'supported', configurable: true, category: 'business', runtimes: ['node', 'browser'] }
] as const
const sourceKeys = ['http', 'mcp', 'task'] as const
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
const fieldSwitch = (wrapper: any, field: string, level = 'info', profile = 'http') =>
  wrapper.get(`#log-field-${profile}-${level}-${field}`)
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
  const incompleteControls = incomplete.fieldControls as unknown as TestControls
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
  // 唯一已实施的 profile 与来自目录的四个级别；不是本地常量拼出来的矩阵。
  const tabs = panel.findAll('[role=tab]')
  expect(tabs).toHaveLength(5)
  expect(tabs[0]!.text()).toBe('HTTP 请求')
  expect(tabs.slice(1).map((tab: any) => tab.text())).toEqual(['调试', '信息', '警告', '错误'])
  expect(panel.findAll('[data-slot=switch]')).toHaveLength(4)
  expect(panel.findAll('input[type=checkbox]')).toHaveLength(0)
  expect(panel.findAll('select')).toHaveLength(0)
  expect(panel.findAll('details')).toHaveLength(0)
  expect(panel.text()).toContain('服务端已知的请求方法')
  expect(panel.text()).toContain('框架匹配或应用定义的固定模板')
  expect(panel.text()).toContain('当前为默认')

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
  expect(panel.text()).toContain('字段选择会保留')
  expect(panel.text()).toContain('这个级别低于当前最低级别警告')
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
  expect(wrapper.text()).toContain('日志配置已保存')
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

it('renders any catalog profile generically, including nested field keys, without local profile knowledge', async () => {
  // Fixture-only second profile: proves the editor is driven by the response
  // catalog. Production never ships a profile the backend has not published.
  const nestedCatalog = [
    ...profileCatalog(),
    {
      key: 'tus',
      source: 'file',
      label: 'TUS 上传',
      levels: [...LEVELS],
      fields: [
        { key: 'tus.method', label: '上传方法', description: '服务端 tus 回调的方法' },
        { key: 'tus.uploadId', label: '上传标识', description: '同一次上传的分片关联' }
      ]
    }
  ]
  const nestedControls = () => {
    const controls = defaultControls() as Record<string, any>
    controls.tus = Object.fromEntries(
      LEVELS.map((level) => [
        level,
        { 'tus.method': true, 'tus.uploadId': true }
      ])
    )
    return controls
  }
  const policy = basePolicy({
    collection: {
      sources: { ...(basePolicy().collection.sources as any), file: rule() },
      integrations: Object.fromEntries(
        [...integrationCatalog, { key: 'tus' }].map((entry) => [entry.key, rule()])
      )
    },
    fieldControls: nestedControls(),
    catalog: { integrations: integrationCatalog, profiles: nestedCatalog }
  })
  const { wrapper, calls } = await mountManagement(() => policy)
  await openPanel(wrapper)
  const tabs = wrapper.get('[data-testid=log-field-controls]').findAll('[role=tab]')
  expect(tabs.slice(0, 2).map((tab: any) => tab.text())).toEqual(['HTTP 请求', 'TUS 上传'])
  // 切到第二个 profile：开关来自它的目录字段，包含嵌套键。
  await tabs[1]!.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const switches = wrapper
    .get('[data-testid=log-field-controls]')
    .findAll('[data-slot=switch]')
  expect(switches).toHaveLength(2)
  expect(document.getElementById('log-field-tus-info-tus.uploadId')).not.toBeNull()
  // 关闭嵌套字段后仍只有这一个 profile 的差异被提交，键名保持服务端原名。
  ;(document.getElementById('log-field-tus-info-tus.uploadId') as HTMLElement).click()
  await flushPromises()
  await review(wrapper)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.querySelector('[data-testid=log-field-review-table]')!.textContent).toContain(
    'TUS 上传 · 信息 · 上传标识'
  )
  await confirm()
  expect(patches(calls)).toEqual([
    {
      retentionDays: 7,
      maxBytes: 536870912,
      fieldControls: { tus: { info: { 'tus.uploadId': false } } }
    }
  ])
  // 改动的父级只按真实存在的来源/集成规则判断；tus 集成在这里是开启的，所以不显示不采集。
  expect(wrapper.get('[data-testid=log-field-controls]').text()).not.toContain('当前不采集')
})

it('renders and PATCHes the real service policy catalog without drifting from the backend shape', async () => {
  const service = createLogService({ directory: ownedDirectory() })
  services.push(service)
  const response = await service.policy()
  // The real response is the only thing driving the editor; the test itself
  // never supplies profile, level or field names.
  expect(response.catalog.profiles.map((profile) => profile.key)).toEqual(['http'])
  const { wrapper, calls } = await mountManagement(
    () => response as unknown as Record<string, unknown>,
    (body) => ({ ...(response as unknown as Record<string, unknown>), ...body, revision: 2 })
  )
  await openPanel(wrapper)
  const fieldConfig = response.catalog.profiles[0]!
  const tabs = wrapper.get('[data-testid=log-field-controls]').findAll('[role=tab]')
  expect(tabs.map((tab: any) => tab.text())).toEqual([
    fieldConfig.label,
    ...fieldConfig.levels.map((level) => LEVEL_LABELS[level])
  ])
  const switches = wrapper.get('[data-testid=log-field-controls]').findAll('[data-slot=switch]')
  expect(switches).toHaveLength(fieldConfig.fields.length)
  expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain('当前为默认')
  // Every real field description renders, i.e. labels come from the catalog.
  for (const field of fieldConfig.fields) {
    expect(wrapper.get('[data-testid=log-field-controls]').text()).toContain(field.description)
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
