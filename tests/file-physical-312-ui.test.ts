// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import DeleteFileDialog from '../components/files/DeleteFileDialog.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const button = (text: string) => [...document.body.querySelectorAll('button')].find(el => el.textContent?.trim() === text)!
const enter = async (id: string, value: string) => {
  const el = document.body.querySelector<HTMLInputElement>(`#${id}`)!
  el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
}
async function setup(state?: string) {
  const fetch = vi.fn(async (url: string, options?: { method?: string }) => {
    if (options?.method) return {}
    if (url.endsWith('/maintenance')) return { revision: 7 }
    if (!state) throw Object.assign(new Error('none'), { statusCode: 404 })
    return { intent: { id: 'original-intent', fileId: 41, relPath: 'original.pdf', state } }
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(DeleteFileDialog, { attachTo: document.body, props: { open: true, fileId: 41, filename: '公告', relPath: 'original.pdf' } })
  await flushPromises()
  return fetch
}
it('defaults to soft removal and does not submit a physical command', async () => {
  const fetch = await setup()
  button('移出文件库').click(); await flushPromises()
  expect(wrapper.emitted('confirm')).toEqual([[false]])
  expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true)
})
it('keeps default soft removal available after an explicitly recovered file', async () => {
  const fetch = await setup('recovered')
  expect(button('移出文件库')).toBeDefined()
  button('移出文件库').click(); await flushPromises()
  expect(wrapper.emitted('confirm')).toEqual([[false]])
  expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true)
})
it('does not carry an uncertain command into another file when its post-write read completes late', async () => {
  const fetch = await setup()
  document.body.querySelector<HTMLButtonElement>('#delete-disk')!.click(); await flushPromises()
  await enter('physical-actor', '测试人员'); await enter('physical-basis', '仅隔离文件41'); await enter('physical-token', 'synthetic-token')
  let resolveOld!: (value: unknown) => void
  fetch.mockImplementation(async (url, opts) => {
    if (opts?.method) throw new Error('file41 completion unknown')
    if (url === '/api/files/41/maintenance') return await new Promise(resolve => { resolveOld = resolve })
    if (url.endsWith('/maintenance')) return { revision: 7 }
    throw Object.assign(new Error('none'), { statusCode: 404 })
  })
  button('确认移出并隔离').click(); await flushPromises()
  expect(resolveOld).toEqual(expect.any(Function))
  await wrapper.setProps({ open: false }); await flushPromises()
  await wrapper.setProps({ open: true, fileId: 42, filename: '另一文件', relPath: 'other.pdf' }); await flushPromises()
  resolveOld({ revision: 7 }); await flushPromises()
  expect(document.body.textContent).not.toContain('file41 completion unknown')
  expect(button('重试原请求')).toBeUndefined()
  expect(fetch.mock.calls.filter(call => call[1]?.method).map(call => call[0])).toEqual(['/api/files/41'])
  button('移出文件库').click(); await flushPromises()
  expect(wrapper.emitted('confirm')).toEqual([[false]])
})
it('retains the exact failed quarantine envelope and retries its original key despite edited revision readback', async () => {
  const fetch = await setup()
  document.body.querySelector<HTMLButtonElement>('#delete-disk')!.click(); await flushPromises()
  await enter('physical-actor', '测试人员'); await enter('physical-basis', '合成文件隔离'); await enter('physical-token', 'synthetic-token')
  fetch.mockImplementation(async (url, opts) => {
    if (opts?.method) throw new Error('completion unknown')
    if (url.endsWith('/maintenance')) return { revision: 8 }
    return { intent: { id: 'held-intent', fileId: 41, relPath: 'original.pdf', state: 'pending' } }
  })
  button('确认移出并隔离').click(); await flushPromises()
  expect(document.body.textContent).toContain('隔离待处理')
  expect(document.body.textContent).toContain('不会自动还原字节')
  button('重试原请求').click(); await flushPromises()
  const writes = fetch.mock.calls.filter(call => call[1]?.method)
  expect(writes).toHaveLength(2)
  const first = writes[0]![1] as unknown as { body: Record<string, unknown> }
  expect(first.body).toMatchObject({ expectedRevision: 7, actor: '测试人员', basis: '合成文件隔离' })
  expect(first.body.idempotencyKey).toEqual(expect.any(String))
  expect(writes[1]).toEqual(writes[0])
})
it('requires explicit confirmation and fresh revision to recover the read-back intent', async () => {
  const fetch = await setup('quarantined')
  expect(document.body.textContent).toContain('已隔离')
  expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true)
  await enter('physical-actor', '测试人员'); await enter('physical-basis', '恢复原件'); await enter('physical-token', 'synthetic-token')
  button('确认恢复原文件').click(); await flushPromises()
  const writes = fetch.mock.calls.filter(call => call[1]?.method)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toEqual(['/api/files/41/physical-recovery', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ intentId: 'original-intent', expectedRevision: 7, actor: '测试人员', basis: '恢复原件' }) })])
})
it('shows recovering and recovered states without automatically issuing recovery', async () => {
  const fetch = await setup('recovering')
  expect(document.body.textContent).toContain('恢复待处理')
  expect(document.body.textContent).toContain('原操作端继续处理')
  expect([...document.body.querySelectorAll('button')].some(el => el.textContent?.trim() === '确认恢复原文件')).toBe(false)
  fetch.mockImplementation(async url => url.endsWith('/maintenance') ? { revision: 9 } : { intent: { id: 'original-intent', fileId: 41, relPath: 'original.pdf', state: 'recovered' } })
  button('读取最新状态').click(); await flushPromises()
  expect(document.body.textContent).toContain('已恢复')
  expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true)
})
it('ignores a stale intent response after switching to another file', async () => {
  let resolveOld!: (value: unknown) => void
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/maintenance')) return { revision: 3 }
    if (url.includes('/41/')) return await new Promise(resolve => { resolveOld = resolve })
    return { intent: { id: 'new-intent', fileId: 42, relPath: 'new.pdf', state: 'recovered' } }
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(DeleteFileDialog, { attachTo: document.body, props: { open: true, fileId: 41, filename: '旧公告', relPath: 'old.pdf' } })
  await flushPromises()
  await wrapper.setProps({ fileId: 42, filename: '新公告', relPath: 'new.pdf' }); await flushPromises()
  expect(document.body.textContent).toContain('已恢复')
  resolveOld({ intent: { id: 'old-intent', fileId: 41, relPath: 'old.pdf', state: 'quarantined' } }); await flushPromises()
  expect(document.body.textContent).toContain('new.pdf')
  expect(document.body.textContent).not.toContain('已隔离')
})
