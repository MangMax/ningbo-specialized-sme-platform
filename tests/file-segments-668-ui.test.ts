// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import EditSegmentsDialog from '../components/files/EditSegmentsDialog.vue'
import type { StoredFileRow } from '../server/utils/stored-files'
const passthrough = defineComponent({ template: '<div><slot /></div>' })
const button = defineComponent({ template: '<button><slot /></button>' })
const input = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />` })
const state = { version: 'a'.repeat(64), parseState: 'unparsed', parts: [], inputLineage: { status: 'unknown' } }
afterEach(() => vi.unstubAllGlobals())
it('keeps a lost-response payload and key for retry, uses a new key for changed drafts, and rereads current state after replay', async () => {
  const commits: unknown[] = []
  let reads = 0
  const fetch = vi.fn(async (url: string, options?: { body: unknown }) => {
    if (url.endsWith('/preflight')) return { expectedVersion: state.version, inputRef: { kind: 'file', pages: [] }, parseState: 'unparsed' }
    if (url.endsWith('/commit')) {
      commits.push(structuredClone(options!.body))
      if (commits.length <= 2) throw Error('controlled lost response')
      return { replayed: true, state: { ...state, parts: [] } }
    }
    reads++
    return { writeEnabled: true, state }
  })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(EditSegmentsDialog, {
    props: { open: false, file: { id: 1, displayName: 'controlled' } as StoredFileRow, refreshList: vi.fn(async () => {}) },
    global: { stubs: { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogDescription: passthrough, DialogFooter: passthrough, Button: button, Input: input, Label: passthrough, Select: passthrough, SelectTrigger: passthrough, SelectValue: passthrough, SelectContent: passthrough, SelectItem: passthrough } },
  })
  await wrapper.setProps({ open: true }); await flushPromises()
  const click = async (text: string) => { await wrapper.findAll('button').find(b => b.text() === text)!.trigger('click'); await flushPromises() }
  await click('新增分段')
  await wrapper.get('#segment-year-0').setValue('0')
  await click('保存分段')
  expect(wrapper.get('[role=alert]').text()).toContain('1900–2100')
  expect(commits).toHaveLength(0)
  await wrapper.get('#segment-year-0').setValue('2022')
  await click('保存分段')
  expect(wrapper.get('#segment-year-0').element).toHaveProperty('value', '2022')
  await click('保存分段')
  expect(commits[1]).toEqual(commits[0])
  await wrapper.get('#segment-year-0').setValue('2025')
  await click('保存分段')
  expect(commits[2]).not.toEqual(commits[0])
  expect(commits[2]).toMatchObject({ parts: [{ year: 2025 }] })
  expect(reads).toBe(2)
  expect(wrapper.text()).toContain('已保存并读回当前分段')
  wrapper.unmount()
})
it('sends the saved declaration ID on coordinate edits while omitting untouched page ranges', async () => {
  const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, attachment: null, rowCount: 2, origin: 'agent', hasConflict: false }
  const current = { ...state, parts: [part], declarations: [{ declarationId: 'saved-stable-id', part, pageRanges: [{ start: 2, end: 3 }] }] }
  const fetch = vi.fn(async (url: string) => url.endsWith('/preflight') ? { expectedVersion: state.version, inputRef: { kind: 'file', pages: [] }, parseState: 'unparsed' } : url.endsWith('/commit') ? {} : { state: current, writeEnabled: true })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(EditSegmentsDialog, { props: { open: false, file: { id: 1, displayName: 'controlled' } as StoredFileRow, refreshList: async () => {} }, global: { stubs: { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogDescription: passthrough, DialogFooter: passthrough, Button: button, Input: input, Label: passthrough, Select: passthrough, SelectTrigger: passthrough, SelectValue: passthrough, SelectContent: passthrough, SelectItem: passthrough } } })
  await wrapper.setProps({ open: true }); await flushPromises()
  await wrapper.get('#segment-year-0').setValue('2025')
  await wrapper.findAll('button').find(b => b.text() === '保存分段')!.trigger('click'); await flushPromises()
  const submitted = fetch.mock.calls.find(call => call[0].endsWith('/commit'))
  expect(submitted).toBeDefined()
  expect(fetch).toHaveBeenCalledWith('/api/files/1/segments/commit', expect.objectContaining({ body: expect.objectContaining({ parts: [expect.objectContaining({ declarationId: 'saved-stable-id', year: 2025 })] }) }))
  const serialized = JSON.stringify(submitted)
  expect(serialized).not.toContain('pageRanges')
  wrapper.unmount()
})
