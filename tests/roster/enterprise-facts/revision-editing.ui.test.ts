// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseFacts from '../../../components/enterprise/EnterpriseFacts.vue'
const row = { id: 1, factId: 1, revision: 1, status: 'pending', action: 'assert', basis: '原件核对', actor: { type: 'agent', id: '记录员' }, createdAt: '2026-11-01T00:00:00Z', fact: { kind: 'moved_out', source: { reference: '公告附件第2页', statement: '原文：迁往地点待核' }, city: null, observed: { precision: 'month', value: '2026-10' }, effective: { precision: 'unknown', value: null } } }
const data = { enterpriseId: 7, version: 'secret-version', facts: [row], history: [row] }
afterEach(() => vi.unstubAllGlobals())
it('older refresh cannot overwrite confirmed post-commit readback', async () => {
  const freshRow = { ...row, status: 'confirmed' }
  const fresh = { ...data, version: 'new-version', facts: [freshRow], history: [freshRow] }
  let reads = 0
  let finish!: (value: unknown) => void
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('browser-preflight')) return { planHash: 'a'.repeat(64) }
    if (url.endsWith('browser-commit')) return { factId: 1 }
    if (++reads === 2) return new Promise(resolve => { finish = resolve })
    return reads === 1 ? data : fresh
  }))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  try {
    await flushPromises()
    await wrapper.get('[data-testid="facts-refresh"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '确认事实')!.trigger('click')
    await wrapper.get('[aria-label="操作依据"]').setValue('原文复核')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('已确认事实')
    finish(data)
    await flushPromises()
    expect(wrapper.text()).toContain('事实操作已记录。')
    expect(wrapper.text()).toContain('已确认事实')
  } finally { wrapper.unmount() }
})
it('shows sourced assertions and history with unknown time and city without technical version inputs', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(data))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  expect(wrapper.text()).toContain('公告附件第2页')
  expect(wrapper.text()).toContain('原文：迁往地点待核')
  expect(wrapper.text()).toContain('2026-10（月）')
  expect(wrapper.text()).toContain('生效时间：未知')
  expect(wrapper.text()).toContain('目的地：未知')
  expect(wrapper.text()).toContain('待确认')
  expect(wrapper.text()).toContain('原件核对')
  expect(wrapper.text()).not.toContain('secret-version')
  expect(wrapper.findAll('input, textarea')).toHaveLength(0)
  wrapper.unmount()
})
it('retains last readback on refresh failure and retries explicitly without showing raw errors', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce({ writeEnabled: false }).mockRejectedValueOnce(new Error('SECRET')).mockResolvedValueOnce({ ...data, facts: [{ ...row, status: 'withdrawn' }] })
  vi.stubGlobal('$fetch', fetcher)
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  await wrapper.get('[data-testid="facts-refresh"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('公告附件第2页')
  expect(wrapper.text()).toContain('事实记录加载失败')
  expect(wrapper.text()).not.toContain('SECRET')
  await wrapper.get('[data-testid="table-retry"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('已撤回')
  expect(wrapper.text()).not.toContain('事实记录加载失败')
  wrapper.unmount()
})
it('treats malformed readback as failure while retaining the last facts', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce({ writeEnabled: false }).mockResolvedValueOnce({}))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  await wrapper.get('[data-testid="facts-refresh"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('事实记录加载失败')
  expect(wrapper.text()).toContain('公告附件第2页')
  expect(wrapper.text()).not.toContain('暂无主体事实记录')
  wrapper.unmount()
})
it('preserves a fact draft and retries the identical command after uncertain commit failure', async () => {
  let commits = 0
  const requests: unknown[] = []
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: { body: unknown }) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('browser-preflight')) return { planHash: 'a'.repeat(64) }
    if (url.endsWith('browser-commit')) { requests.push(options!.body); if (++commits === 1) throw new Error('network'); return { factId: 2 } }
    return data
  }))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  await wrapper.get('[data-testid="fact-new"]').trigger('click')
  await wrapper.get('[aria-label="来源引用"]').setValue('新的来源')
  await wrapper.get('[aria-label="来源原文"]').setValue('原文')
  await wrapper.get('[aria-label="操作依据"]').setValue('核对附件')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect((wrapper.get('[aria-label="来源原文"]').element as HTMLTextAreaElement).value).toBe('原文')
  expect(wrapper.text()).toContain('草稿已保留')
  expect(wrapper.emitted('saved')).toBeUndefined()
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(wrapper.emitted('saved')).toHaveLength(1)
  expect(wrapper.find('form').exists()).toBe(false)
  wrapper.unmount()
})
it.each([['确认事实', 'confirm'], ['更正事实', 'replace'], ['撤回事实', 'withdraw']])('submits %s with a basis and hidden preflight mechanics', async (label, action) => {
  const commands: any[] = []
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: { body: any }) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('browser-preflight')) { commands.push(options!.body); return { planHash: 'b'.repeat(64) } }
    if (url.endsWith('browser-commit')) return { factId: 1 }
    return data
  }))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === label)!.trigger('click')
  await wrapper.get('[aria-label="操作依据"]').setValue('逐项核对')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({ action, factId: 1, basis: '逐项核对', expectedVersion: 'secret-version' })
  expect(wrapper.emitted('saved')).toHaveLength(1)
  if (action === 'replace') expect(commands[0].fact).toEqual(row.fact)
  expect(wrapper.text()).not.toContain('secret-version')
  wrapper.unmount()
})
it('refreshes a conflict while keeping the draft and uses refreshed version only on explicit resubmission', async () => {
  let reads = 0
  const commands: any[] = []
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: { body: any }) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('browser-preflight')) {
      commands.push(JSON.parse(JSON.stringify(options!.body)))
      if (commands.length === 1) throw { data: { error: { code: 'version_conflict' } } }
      return { planHash: 'c'.repeat(64) }
    }
    if (url.endsWith('browser-commit')) return { factId: 1 }
    return { ...data, version: ++reads === 1 ? 'old' : 'new' }
  }))
  const wrapper = mount(EnterpriseFacts, { props: { enterpriseId: 7 } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '确认事实')!.trigger('click')
  await wrapper.get('[aria-label="操作依据"]').setValue('冲突时保留的依据')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(commands).toHaveLength(1)
  expect(wrapper.text()).toContain('草稿已保留')
  expect((wrapper.get('[aria-label="操作依据"]').element as HTMLTextAreaElement).value).toBe('冲突时保留的依据')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(commands[1]).toMatchObject({ expectedVersion: 'new', basis: '冲突时保留的依据' })
  expect(commands[1].idempotencyKey).not.toBe(commands[0].idempotencyKey)
  wrapper.unmount()
})
