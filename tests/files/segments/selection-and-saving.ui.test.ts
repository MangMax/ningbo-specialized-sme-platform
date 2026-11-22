// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import FileSegmentsEditor from '../../../layers/sme-roster/app/components/sme-roster/RosterFileSegmentsEditor.vue'
import type { FileRow } from '../../../layers/core/server/utils/file-store-contract'
const passthrough = defineComponent({ template: '<div><slot /></div>' })
const button = defineComponent({ template: '<button><slot /></button>' })
const input = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
})
const select = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<select :value="modelValue" @change="$emit('update:modelValue',$event.target.value)"><option value=""></option><slot /></select>`,
})
const option = defineComponent({
  props: ['value'],
  template: '<option :value="value"><slot /></option>',
})
const part = {
  titleCode: 'specialized_sme',
  eventKind: 'review',
  year: 2023,
  batch: 1,
  attachment: '附件1',
  rowCount: 484,
}
const declaration = (id: string, sequence: number) => ({
  declarationId: id,
  displaySequence: sequence,
  part: { ...part },
  pageRanges: [{ start: 2, end: 3 }],
})
const base = {
  version: 'a'.repeat(64),
  parseState: 'unparsed',
  parts: [{ ...part, origin: 'derived' }],
  declarations: [],
  registeredSummary: { count: 0, declarations: [] },
  ingestionStatistics: { rowCount: 489, parts: [part] },
}
function setup(
  declarations: ReturnType<typeof declaration>[] = [],
  behavior?: (url: string, options?: { body: unknown }) => unknown,
) {
  const current = {
    ...base,
    declarations,
    registeredSummary: { count: declarations.length, declarations },
  }
  const fetch = vi.fn(async (url: string, options?: { body: unknown }) => {
    if (behavior) {
      const value = await behavior(url, options)
      if (value !== undefined) return value
    }
    if (url.endsWith('/preflight'))
      return {
        expectedVersion: base.version,
        inputRef: { kind: 'file', pages: [] },
        parseState: 'unparsed',
      }
    if (url.endsWith('/commit')) return {}
    return { state: current, writeEnabled: true }
  })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(FileSegmentsEditor, {
    props: {
      open: true,
      file: { id: 19 } as FileRow,
      refreshList: async () => {},
    },
    global: {
      stubs: {
        RosterFileEventSync: true,
        DisclosurePanel: passthrough,
        Dialog: passthrough,
        DialogContent: passthrough,
        DialogHeader: passthrough,
        DialogTitle: passthrough,
        DialogDescription: passthrough,
        DialogFooter: passthrough,
        Button: button,
        Input: input,
        Label: passthrough,
        Select: select,
        SelectTrigger: passthrough,
        SelectValue: true,
        SelectContent: passthrough,
        SelectItem: option,
      },
    },
  })
  const click = async (text: string) => {
    await wrapper
      .findAll('button')
      .find((b) => b.text() === text)!
      .trigger('click')
    await flushPromises()
  }
  return { wrapper, fetch, click, current }
}
afterEach(() => vi.unstubAllGlobals())
it('shows zero declarations despite 489 ingested events and adds only one blank draft with explicit cancellation', async () => {
  const { wrapper, fetch, click } = setup()
  await flushPromises()
  expect(wrapper.text()).toContain('0 段已登记')
  expect(wrapper.text()).toContain('尚未登记文件内容分段')
  expect(wrapper.findAll('button').some((b) => b.text() === '修改')).toBe(false)
  await click('新增分段')
  expect(
    wrapper
      .findAll('select')
      .map((s) => (s.element as HTMLSelectElement).value),
  ).toEqual(['', ''])
  expect(
    wrapper
      .findAll('button')
      .find((b) => b.text() === '新增分段')!
      .attributes('disabled'),
  ).toBeDefined()
  await click('保存分段')
  expect(wrapper.get('[role=alert]').text()).toContain('请选择称号和事件')
  await click('取消新增')
  expect(wrapper.text()).toContain('尚未登记文件内容分段')
  expect(fetch).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})
it('edits stable ID in place, preserves other IDs and values, independently allows unknown batch, and never sends sequence', async () => {
  const { wrapper, fetch, click } = setup([
    declaration('one', 1),
    declaration('two', 2),
  ])
  await flushPromises()
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2025')
  await wrapper.get('#segment-batch-19-0').setValue('')
  await click('保存修改')
  const body = fetch.mock.calls.find((c) => c[0].endsWith('/commit'))![1]!
    .body as { parts: unknown[] }
  expect(body.parts).toEqual([
    { ...part, declarationId: 'one', year: 2025, batch: null },
    { ...part, declarationId: 'two' },
  ])
  expect(JSON.stringify(body)).not.toContain('displaySequence')
  expect(wrapper.text()).toContain('已保存并读回当前分段')
  wrapper.unmount()
})
it('cancel restores snapshot without writes; textual delete blocks other operations and only removes target ID', async () => {
  const { wrapper, fetch, click } = setup([
    declaration('one', 1),
    declaration('two', 2),
  ])
  await flushPromises()
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2025')
  await click('取消')
  expect(wrapper.text()).not.toContain('2025')
  expect(fetch).toHaveBeenCalledTimes(1)
  await click('删除分段')
  expect(wrapper.text()).toContain('已入库企业记录不会删除')
  expect(
    wrapper
      .findAll('button')
      .find((b) => b.text() === '新增分段')!
      .attributes('disabled'),
  ).toBeDefined()
  await click('确认删除')
  expect(fetch).toHaveBeenCalledWith(
    '/api/files/19/segments/commit',
    expect.objectContaining({
      body: expect.objectContaining({
        parts: [{ ...part, declarationId: 'two' }],
      }),
    }),
  )
  wrapper.unmount()
})
it('retries uncertain payload with original key, changing drafts uses a new key, and confirmed commit read failure only rereads', async () => {
  let commits = 0,
    readFail = false
  const { wrapper, fetch, click } = setup([declaration('one', 1)], (url) => {
    if (url.endsWith('/commit')) {
      commits++
      if (commits <= 2) throw Error('lost response')
      readFail = true
      return {}
    }
    if (url.endsWith('/segments') && readFail) throw Error('read unavailable')
  })
  await flushPromises()
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2025')
  await click('保存修改')
  await click('重试保存')
  const bodies = () =>
    fetch.mock.calls
      .filter((c) => c[0].endsWith('/commit'))
      .map((c) => c[1]!.body)
  expect(bodies()[1]).toEqual(bodies()[0])
  await wrapper.get('#segment-year-19-0').setValue('2024')
  await click('保存修改')
  expect(bodies()[2]).not.toEqual(bodies()[0])
  expect(wrapper.text()).toContain('提交已确认，读取最新内容失败')
  await click('重试读取')
  expect(commits).toBe(3)
  readFail = false
  await click('重试读取')
  expect(wrapper.text()).toContain('已保存并读回当前分段')
  wrapper.unmount()
})
it('submits multiple physical page ranges and keeps draft on CAS conflict', async () => {
  const { wrapper, fetch, click } = setup([declaration('one', 1)], (url) => {
    if (url.endsWith('/commit')) throw Error('409 version conflict')
  })
  await flushPromises()
  await click('修改')
  await click('新增页码范围')
  await wrapper.get('#range-start-19-0-1').setValue('5')
  await wrapper.get('#range-end-19-0-1').setValue('7')
  await click('保存修改')
  expect(fetch).toHaveBeenCalledWith(
    '/api/files/19/segments/preflight',
    expect.objectContaining({
      body: { expectedVersion: base.version, verifyPhysicalPages: true },
    }),
  )
  expect(fetch).toHaveBeenCalledWith(
    '/api/files/19/segments/commit',
    expect.objectContaining({
      body: expect.objectContaining({
        parts: [
          expect.objectContaining({
            declarationId: 'one',
            pageRanges: [
              { start: 2, end: 3 },
              { start: 5, end: 7 },
            ],
          }),
        ],
      }),
    }),
  )
  expect(wrapper.get('#range-end-19-0-1').element).toHaveProperty('value', '7')
  expect(wrapper.get('[role=alert]').text()).toContain('409')
  wrapper.unmount()
})
it('requires save, discard or stay before leaving an active draft', async () => {
  const { wrapper, fetch, click } = setup([declaration('one', 1)])
  await flushPromises()
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2025')
  const requestLeave = (
    wrapper.vm as unknown as { requestLeave: () => Promise<boolean> }
  ).requestLeave
  let result = requestLeave()
  await flushPromises()
  await click('留在当前')
  expect(await result).toBe(false)
  expect(wrapper.get('#segment-year-19-0').element).toHaveProperty(
    'value',
    '2025',
  )
  result = requestLeave()
  await flushPromises()
  await click('放弃修改并离开')
  expect(await result).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2026')
  result = requestLeave()
  await flushPromises()
  await click('保存后离开')
  expect(await result).toBe(true)
  expect(fetch.mock.calls.filter((c) => c[0].endsWith('/commit'))).toHaveLength(
    1,
  )
  wrapper.unmount()
})
it('uses persistent displaySequence rather than content year when server array is reversed', async () => {
  const one = declaration('one', 2),
    two = declaration('two', 1)
  one.part.year = 2020
  two.part.year = 2025
  const { wrapper, click } = setup([one, two])
  await flushPromises()
  await click('修改')
  expect(wrapper.get('#segment-year-19-0').element).toHaveProperty(
    'value',
    '2025',
  )
  await wrapper.get('#segment-year-19-0').setValue('2021')
  await click('保存修改')
  await click('修改')
  expect(wrapper.get('#segment-year-19-0').element).toHaveProperty(
    'value',
    '2025',
  )
  wrapper.unmount()
})
it('recovers a stale version explicitly while preserving the draft and latest unrelated declarations', async () => {
  let conflict = true,
    latest = false
  const other = declaration('two', 2)
  const { wrapper, fetch, click } = setup([declaration('one', 1)], (url) => {
    if (url.endsWith('/commit') && conflict)
      throw Object.assign(Error('version conflict'), { statusCode: 409 })
    if (url.endsWith('/segments') && latest)
      return {
        state: {
          ...base,
          version: 'b'.repeat(64),
          declarations: [declaration('one', 1), other],
          registeredSummary: {
            count: 2,
            declarations: [declaration('one', 1), other],
          },
        },
        writeEnabled: true,
      }
  })
  await flushPromises()
  await click('修改')
  await wrapper.get('#segment-year-19-0').setValue('2025')
  await click('保存修改')
  expect(wrapper.get('[role=alert]').text()).toContain('保存版本已过期')
  latest = true
  await click('读取最新版本并保留草稿')
  expect(wrapper.get('#segment-year-19-0').element).toHaveProperty(
    'value',
    '2025',
  )
  expect(wrapper.text()).toContain('请核对后重新保存')
  expect(fetch.mock.calls.filter((c) => c[0].endsWith('/commit'))).toHaveLength(
    1,
  )
  conflict = false
  await click('保存修改')
  expect(
    fetch.mock.calls.filter((c) => c[0].endsWith('/preflight')).at(-1)![1]!
      .body,
  ).toEqual({ expectedVersion: 'b'.repeat(64) })
  expect(
    fetch.mock.calls.filter((c) => c[0].endsWith('/commit')).at(-1)![1]!.body,
  ).toEqual(
    expect.objectContaining({
      parts: [
        { ...part, declarationId: 'one', year: 2025 },
        { ...part, declarationId: 'two' },
      ],
    }),
  )
  wrapper.unmount()
})
