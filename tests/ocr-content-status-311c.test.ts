// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createRouter, createMemoryHistory, useRoute } from 'vue-router'
import { expect, it, vi } from 'vitest'
import { useOcrWorkbench } from '../composables/useOcrWorkbench'
it('current page conflict keeps historical OCR text and binding while disabling writes', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/files') return { rows: [{ id: 1, relPath: 'old.pdf', ext: 'pdf', filename: 'old.pdf', parts: [] }], total: 1 }
    if (url === '/api/pdf-pages') throw { data: { data: { code: 'file_content_conflict' } } }
    return { count: 1, contentIdentity: { status: 'file_content_conflict' }, pages: [{ page: 3, version: 'v1', markdown: '独立历史正文', historicalBinding: { status: 'captured', input: { taskId: 'old' } } }] }
  }))
  let work!: ReturnType<typeof useOcrWorkbench>
  const wrapper = mount(defineComponent({ setup() { work = useOcrWorkbench(); return () => 'workbench' } }), { global: { plugins: [router] } })
  await work.loadFiles()
  work.selectedPath.value = 'old.pdf'
  await flushPromises()
  expect(work.rows.value[0]?.result?.markdown).toBe('独立历史正文')
  expect(work.rows.value[0]?.result?.historicalBinding?.status).toBe('captured')
  expect(work.contentMessage.value).toContain('内容已变化')
  expect(work.detailError.value).toContain('内容已变化')
  expect(work.loadedPath.value).toBe('old.pdf')
  wrapper.unmount()
  vi.unstubAllGlobals()
})

import UploadDialog from '../components/files/UploadDialog.vue'
it('registration retry keeps the uploaded metadata snapshot after conflict', async () => {
  const api = vi.fn().mockRejectedValueOnce({ data: { data: { code: 'file_content_conflict' } } }).mockResolvedValueOnce({})
  vi.stubGlobal('$fetch', api)
  const wrapper = mount(UploadDialog, { props: { open: true }, global: { stubs: { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, UploadPanel: { name: 'UploadPanel', template: '<div />' }, Dialog: { template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } } } })
  const payload = { name: '原附件.pdf', relPath: 'jxj/announcement/2024/1/a.pdf', size: 3, meta: { source: 'jxj', kind: 'announcement', year: '2024', batch: '1' } }
  wrapper.findComponent({ name: 'UploadPanel' }).vm.$emit('uploaded', payload)
  await flushPromises()
  expect(wrapper.text()).toContain('内容已变化')
  expect(wrapper.text()).toContain('重试登记 原附件.pdf')
  await wrapper.findAll('button').find(button => button.text().includes('重试登记'))!.trigger('click')
  await flushPromises()
  expect(api.mock.calls[1]?.[1].body).toEqual({ relPath: payload.relPath, source: 'jxj', kind: 'announcement', year: '2024', batch: '1' })
  expect(wrapper.emitted('registered')).toHaveLength(1)
  wrapper.unmount()
  vi.unstubAllGlobals()
})
