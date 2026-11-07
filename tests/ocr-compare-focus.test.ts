// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OcrWorkbench from '../components/ocr/OcrWorkbench.vue'
import { Dialog } from '../components/ui/dialog'

// Only data/network ownership is replaced. Workbench, keyed Row, Vue Transition
// and Reka Dialog/FocusScope/Presence are real; no shared focus implementation stub.
let state: Record<string, any>
vi.mock('../composables/useOcrWorkbench', () => ({ useOcrWorkbench: () => state }))
let wrapper: ReturnType<typeof mount> | undefined
let compareDialog: any
let frames: FrameRequestCallback[]
let style: HTMLStyleElement
const row = (page: number) => ({ page, result: null, image: {
  page, url: `/page-${page}.png`, relPath: `p${page}.png`, width: 100, height: 100, bytes: 1,
} })
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false,
    addEventListener() {}, removeEventListener() {} }))
  // jsdom has no layout/checkVisibility: model only CSS visibility, independently
  // of the product's activeElement success check. Real Chrome verifies layout.
  style = document.createElement('style')
  style.textContent = '.hidden { display: none }'
  document.head.append(style)
  const nativeFocus = HTMLElement.prototype.focus
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement, options) {
    for (let e: HTMLElement | null = this; e; e = e.parentElement)
      if (getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return
    nativeFocus.call(this, options)
  })
  const values: Record<string, any> = {
    selectedPath: 'a.pdf', currentPage: 1, rows: [row(1), row(2), row(3)],
    visibleRows: [row(1), row(2), row(3)], selected: { filename: 'a.pdf' },
    filters: { states: [], range: '', text: '' }, counts: { text: 0, empty: 0, none: 3 },
    pdfFiles: [], fileMatches: [], fileYears: [], pageNumbers: [1, 2, 3],
    pendingPage: null, rowFailure: null, justSaved: null, dirty: false,
    detailLoading: false, writeBusy: false, needsRead: false, imageVersion: null, filesLoading: false, filesError: '', keyword: '', source: '', year: '', rendering: false, canImport: false, pageCount: 3, renderedCount: 3, importOpen: false, importPending: false, importFailure: '', importResult: null, status: null, notice: '', contentMessage: '', ready: true, loadedPath: 'a.pdf', view: 'image', detailError: '',
  }
  state = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)]))
  state.currentRow = computed(() => state.rows.value.find((r: any) => r.page === state.currentPage.value))
  state.navigate = (page: number) => { state.currentPage.value = page }
  state.setView = (view: string) => { state.view.value = view }
})
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined
  document.body.innerHTML = ''; style.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function frame() {
  const batch = frames.splice(0)
  batch.forEach(cb => cb(0))
  await nextTick(); await flushPromises()
}
async function start() {
  wrapper = mount(OcrWorkbench, { attachTo: document.body, global: { stubs: { transition: false } } })
  await flushPromises()
  const entry = wrapper.get('[aria-label="打开当前页对照"]')
  await entry.trigger('click'); await flushPromises()
  return entry.element as HTMLButtonElement
}
function close() {
  compareDialog = wrapper!.findAllComponents(Dialog).find(d => d.props('open'))!
  compareDialog.vm.$emit('update:open', false)
}
async function settle() { await frame(); await frame(); await flushPromises() }

it('Transition after-enter observes the connected new row after hidden old row leaves', async () => {
  const original = await start()
  state.currentPage.value = 2
  await nextTick()
  expect(original.isConnected).toBe(true)
  expect(original.closest('li')!.classList.contains('hidden')).toBe(true)
  await settle()
  expect(original.isConnected).toBe(false)
  const entry = wrapper!.get('[aria-label="打开当前页对照"]').element
  expect(entry.isConnected).toBe(true)
  expect(entry.closest('li')!.classList.contains('v-enter-from')).toBe(false)
})

it('connected hidden old entry cannot consume close; current keyed row restores once after enter', async () => {
  const original = await start()
  state.currentPage.value = 2
  await nextTick()
  expect(original.isConnected).toBe(true)
  expect(getComputedStyle(original.closest('li')!).display).toBe('none')
  close(); await flushPromises()
  expect(document.activeElement).not.toBe(original)
  await settle()
  const entry = wrapper!.get('[aria-label="打开当前页对照"]').element
  expect(entry).not.toBe(original)
  expect(document.activeElement).toBe(entry)
  const sentinel = document.createElement('button'); document.body.append(sentinel); sentinel.focus()
  await settle()
  expect(document.activeElement).toBe(sentinel)
})

it('same page preserves the actual image entry instead of the header', async () => {
  await start(); close(); await flushPromises()
  const image = wrapper!.get('[aria-label="放大看第 1 页"]')
  await image.trigger('click'); await flushPromises()
  close(); await flushPromises()
  expect(document.activeElement).toBe(image.element)
  expect(state.currentPage.value).toBe(1)
})

it('already remounted close uses its current entry and never a same-label wrong node', async () => {
  const original = await start()
  const wrong = document.createElement('button'); wrong.setAttribute('aria-label', '打开当前页对照')
  document.body.prepend(wrong)
  state.currentPage.value = 2; await nextTick(); await settle()
  expect(original.isConnected).toBe(false)
  close(); await flushPromises()
  expect(document.activeElement).toBe(wrapper!.get('[aria-label="打开当前页对照"]').element)
  expect(document.activeElement).not.toBe(wrong)
  expect(state.currentPage.value).toBe(2)
})

it('focus no-op cannot consume intent before the actual enter lifecycle', async () => {
  await start()
  state.currentPage.value = 2; await nextTick()
  const entry = wrapper!.findAll('[aria-label="打开当前页对照"]').at(-1)!.element as HTMLElement
  const blocked = vi.spyOn(entry, 'focus').mockImplementation(() => {})
  close(); await flushPromises()
  expect(document.activeElement).not.toBe(entry)
  blocked.mockRestore()
  await settle()
  expect(document.activeElement).toBe(entry)
})

it.each(['reopen', 'file', 'page', 'unmount'] as const)('%s cancels the pending close before a late enter', async action => {
  await start()
  state.currentPage.value = 2; await nextTick()
  close(); await flushPromises()
  if (action === 'reopen') compareDialog.vm.$emit('update:open', true)
  if (action === 'file') state.selectedPath.value = 'b.pdf'
  if (action === 'page') state.currentPage.value = 3
  if (action === 'unmount') { wrapper!.unmount(); wrapper = undefined }
  await nextTick(); await flushPromises()
  const sentinel = document.createElement('button'); document.body.append(sentinel)
  // Reopened modal legitimately traps focus; all other paths use a distinct target.
  if (action !== 'reopen') sentinel.focus()
  const owned = document.activeElement
  await settle()
  expect(document.activeElement).toBe(owned)
  if (action === 'reopen') expect(document.activeElement?.closest('[data-ocr-comparison]')).toBeTruthy()
})

it('a newer explicit focus target cancels close before late enter', async () => {
  await start()
  state.currentPage.value = 2; await nextTick()
  const entry = wrapper!.findAll('[aria-label="打开当前页对照"]').at(-1)!.element as HTMLElement
  const blocked = vi.spyOn(entry, 'focus').mockImplementation(() => {})
  close(); await flushPromises()
  blocked.mockRestore()
  const sentinel = document.createElement('button'); document.body.append(sentinel); sentinel.focus()
  await settle()
  expect(document.activeElement).toBe(sentinel)
})
