// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import OcrPage from '../../../pages/ocr.vue'
import OcrPageRow from '../../../components/ocr/OcrPageRow.vue'
import type { WorkbenchRow } from '../../../lib/ocr-workbench'

/**
 * 「识别校对」页的读回/写回竞态、草稿保护、筛选与单页工作区回归。
 *
 * 这一页现在的结构是「一页一屏」：文件选择与筛选按需开 Sheet，唯一翻页器在
 * 固定底栏，阅读态「编辑」/编辑态「保存」都在底栏。测试仍只通过用户可见的
 * 入口操作（打开 Sheet、点按钮、填输入），不依赖私有组件结构。
 */

// DOM emulators' partial WAAPI rejects cancelled decorative tab animations. Use the
// same no-WAAPI runtime as tabs-ui tests; browser acceptance checks actual motion.
const nativeAnimate = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'animate',
)
beforeAll(() => {
  Reflect.deleteProperty(Element.prototype, 'animate')
})
afterAll(() => {
  if (nativeAnimate)
    Object.defineProperty(Element.prototype, 'animate', nativeAnimate)
})

const FILE_A = {
  displayName: 'A-慢.pdf',
  source: 'jxj',
  year: 2024,
  id: 1,
  relPath: 'jxj/announcement/2024/1/A-慢.pdf',
  filename: 'A-慢.pdf',
  ext: 'pdf',
  parseState: 'unparsed',
}
const FILE_B = {
  displayName: 'B-快.pdf',
  source: 'miit',
  year: 2023,
  id: 2,
  relPath: 'jxj/announcement/2024/2/B-快.pdf',
  filename: 'B-快.pdf',
  ext: 'pdf',
  parseState: 'unparsed',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

function pagesState(file: string, pageCount = 1) {
  return {
    file,
    pageCount,
    dpi: 200,
    rendered: 0,
    upToDate: false,
    pages: [],
    manifest: null,
  }
}

function renderOutcome(file: string, pageCount: number) {
  return {
    ...pagesState(file, pageCount),
    rendered: pageCount,
    upToDate: true,
    written: pageCount,
    skipped: 0,
    removed: 0,
    elapsedMs: 12,
  }
}

function ocrList(file: string, text: string | undefined) {
  return {
    file: {
      id: 1,
      relPath: file,
      filename: file,
      ext: 'pdf',
      parseState: 'unparsed',
    },
    channels: ['upload'],
    pages: [
      {
        page: 1,
        version: '101:1',
        engine: 'paddleocr',
        model: null,
        channel: 'upload',
        createdAt: '2026-10-15T00:00:00.000Z',
        ...(text === undefined ? {} : { markdown: text }),
        pageRelPath: null,
        url: null,
      },
    ],
    count: 1,
  }
}

interface Harness {
  fetchMock: ReturnType<typeof vi.fn>
  pdf: Map<string, ReturnType<typeof deferred<unknown>>>
  ocr: Map<string, ReturnType<typeof deferred<unknown>>>
  render: Map<string, ReturnType<typeof deferred<unknown>>>
  wrapper: ReturnType<typeof mount>
  router: ReturnType<typeof createRouter>
}

async function mountPage(url = '/ocr'): Promise<Harness> {
  const pdf = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const ocr = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const render = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const fetchMock = vi.fn(
    (
      url: string,
      opts?: {
        query?: Record<string, unknown>
        method?: string
        body?: { file?: string }
      },
    ) => {
      if (url === '/api/files')
        return Promise.resolve({ rows: [FILE_A, FILE_B], total: 2 })
      if (url === '/api/pdf-pages' && opts?.method === 'POST') {
        const gate = deferred<unknown>()
        render.set(String(opts.body?.file ?? ''), gate)
        return gate.promise
      }
      const file = String(opts?.query?.file ?? '')
      if (url === '/api/pdf-pages') {
        const gate = deferred<unknown>()
        pdf.set(file, gate)
        return gate.promise
      }
      if (url === '/api/ocr-results') {
        const gate = deferred<unknown>()
        ocr.set(file, gate)
        return gate.promise
      }
      return Promise.resolve({})
    },
  )
  vi.stubGlobal('$fetch', fetchMock)

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/ocr', component: OcrPage }],
  })
  await router.push(url)
  await router.isReady()
  const wrapper = mount(RouterView, {
    attachTo: document.body,
    global: {
      plugins: [router],
      components: {
        PageHeader: { template: '<header><slot name="actions" /></header>' },
      },
    },
  })
  await flushPromises()
  return { fetchMock, pdf, ocr, render, wrapper, router }
}

function body() {
  return new DOMWrapper(document.body)
}

/** 打开文件 Sheet；返回 teleported 的 body 包装。 */
async function openFileSheet(wrapper: Harness['wrapper']) {
  await wrapper.get('button[aria-label="选择 PDF 文件"]').trigger('click')
  await flushPromises()
  return body()
}

async function selectFile(wrapper: Harness['wrapper'], label: string) {
  const sheet = await openFileSheet(wrapper)
  const button = sheet
    .findAll('[data-slot="sheet-content"] li button')
    .find((item) => item.text().includes(label))
  expect(button, `文件 Sheet 应有「${label}」`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

async function openFilters(wrapper: Harness['wrapper']) {
  const trigger = wrapper
    .findAll('button')
    .find((item) => item.text().replace(/\s/g, '').startsWith('筛选'))
  expect(trigger, '应有筛选入口').toBeTruthy()
  await trigger!.trigger('click')
  await flushPromises()
  return body()
}

async function applyFilters(wrapper: Harness['wrapper']) {
  const sheet = body()
  const apply = sheet
    .findAll('button')
    .find((item) => item.text().trim() === '应用筛选')
  expect(apply, '筛选 Sheet 应有应用按钮').toBeTruthy()
  await apply!.trigger('click')
  await flushPromises()
}

async function clearFilters(wrapper: Harness['wrapper']) {
  const sheet = await openFilters(wrapper)
  const clear = sheet
    .findAll('button')
    .find((item) => item.text().trim() === '清除全部')
  expect(clear).toBeTruthy()
  await clear!.trigger('click')
  await flushPromises()
}

async function setStates(wrapper: Harness['wrapper'], states: string[]) {
  const sheet = await openFilters(wrapper)
  for (const state of states) {
    const checkbox = sheet.get(`#ocr-state-${state}`)
    if (checkbox.attributes('data-state') !== 'checked')
      await checkbox.trigger('click')
  }
  return sheet
}

async function jumpTo(wrapper: Harness['wrapper'], value: string) {
  // 桌面页导航在跳页后保持打开（方便连续翻看），所以只在新开时点触发器。
  const trigger = wrapper.get('button[aria-label="跳转实际页号"]')
  if (trigger.attributes('aria-expanded') !== 'true') {
    await trigger.trigger('click')
    await flushPromises()
  }
  const sheet = body()
  const input = sheet.get('input[aria-label="跳转实际页号"]')
  await input.setValue(value)
  const submit = sheet
    .findAll('button')
    .find((item) => item.text().trim() === '跳转')!
  await submit.trigger('click')
  await flushPromises()
}

async function openPageNav(wrapper: Harness['wrapper']) {
  const trigger = wrapper.get('button[aria-label="跳转实际页号"]')
  if (trigger.attributes('aria-expanded') !== 'true') {
    await trigger.trigger('click')
    await flushPromises()
  }
  return body()
}

function pageCells() {
  return body().findAll('[data-ocr-page-cell]')
}

function rows(wrapper: Harness['wrapper']) {
  return wrapper.findAll('ul[role="list"] li')
}

function button(wrapper: Harness['wrapper'], text: string) {
  return wrapper.findAll('button').find((item) => item.text().trim() === text)!
}

/** 取消一个 dirty 编辑：必须经过明确的放弃确认。 */
async function confirmDiscard(wrapper: Harness['wrapper']) {
  await button(wrapper, '取消').trigger('click')
  await flushPromises()
  const dialog = new DOMWrapper(document.body)
    .findAll('[data-slot="dialog-content"]')
    .at(-1)!
  expect(dialog.text(), '取消 dirty 草稿必须弹出放弃确认').toContain(
    '放弃未保存的校对',
  )
  const discard = dialog
    .findAll('button')
    .find((item) => item.text().trim() === '放弃草稿')
  expect(discard, '确认弹层应有「放弃草稿」').toBeTruthy()
  await discard!.trigger('click')
  await flushPromises()
}

function pageText(wrapper: Harness['wrapper']) {
  return wrapper.get('[aria-label="当前文件与页号"]').text()
}

async function openWorkbenchMenu(wrapper: Harness['wrapper']) {
  const trigger = wrapper.get('button[aria-label="工作台更多操作"]')
  await trigger.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  return body()
}

async function openRowMenu(wrapper: Harness['wrapper']) {
  const trigger = wrapper.get('button[aria-label="本页更多操作"]')
  await trigger.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  return body()
}

async function chooseMenu(bodyWrapper: DOMWrapper<Element>, label: string) {
  const item = bodyWrapper
    .findAll('[role="menuitem"]')
    .find((entry) => entry.text().includes(label))
  expect(item, `菜单应有「${label}」`).toBeTruthy()
  await item!.trigger('click')
  await flushPromises()
  // reka-ui restores focus to the trigger on close; let that settle before the
  // test performs the next explicit focus action.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
}

async function loadA(
  pageCount = 4,
  markdown = '甲公司',
  page2Markdown = '',
  imagePages: number[] = [],
) {
  harness = await mountPage()
  await selectFile(harness.wrapper, 'A-慢')
  const response = ocrList(FILE_A.relPath, markdown)
  response.pages.push({ ...response.pages[0]!, page: 2, markdown: page2Markdown })
  response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
  response.count = 3
  harness.ocr.get(FILE_A.relPath)!.resolve(response)
  harness.pdf.get(FILE_A.relPath)!.resolve({
    ...pagesState(FILE_A.relPath, pageCount),
    pages: imagePages.map((page) => ({
      page,
      relPath: `pages/${FILE_A.relPath}/p${page}.png`,
      url: `/api/files/pages/p${page}.png`,
      width: 1000,
      height: 1414,
      bytes: 1024,
    })),
  })
  await flushPromises()
  return harness
}

let harness: Harness | null = null

describe("校对页版本保护", () => {
  it('读取真实版本并用于保存，首次新增明确要求页不存在', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    expect(fetchMock.mock.calls.find(([url]) => url === '/api/ocr-results')?.[1])
      .toMatchObject({ query: { includeVersion: '1' } })
    const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) => opts?.method === 'POST'
      ? Promise.resolve({}) : original(url, opts))
    await button(wrapper, '编辑').trigger('click')
    await wrapper.get('textarea').setValue('保存新正文')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')?.[1])
      .toMatchObject({ body: { expectedVersion: '101:1', mode: 'versioned' } })
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '保存新正文'))
    await flushPromises()
    await jumpTo(wrapper, '3')
    await button(wrapper, '手工录入').trigger('click')
    await wrapper.get('textarea').setValue('首次新增')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST').at(-1)?.[1])
      .toMatchObject({ body: { page: 3, expectedVersion: null, mode: 'versioned' } })
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '保存新正文'))
    await flushPromises()
  })

  it('未返回页版本时关闭写入，不能降级为无条件覆盖', async () => {
    harness = await mountPage()
    await selectFile(harness.wrapper, 'A-慢')
    const response = ocrList(FILE_A.relPath, '有正文无版本')
    Reflect.deleteProperty(response.pages[0]!, 'version')
    harness.ocr.get(FILE_A.relPath)!.resolve(response)
    harness.pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()
    expect(harness.wrapper.text()).toContain('页版本没读回来')
    expect(harness.wrapper.find('textarea').exists()).toBe(false)
    expect(harness.fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0)
  })

  it('保存409保留草稿，只能先重新读取，新版本读回后仍保留编辑稿', async () => {
    const { wrapper, fetchMock, ocr, pdf } = await loadA()
    const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) => opts?.method === 'POST'
      ? Promise.reject({ statusCode: 409, data: { message: '版本冲突' } })
      : original(url, opts))
    await button(wrapper, '编辑').trigger('click')
    await wrapper.get('textarea').setValue('A窗口编辑稿')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('编辑稿已保留')
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'A窗口编辑稿')
    expect(button(wrapper, '保存').attributes('disabled')).toBeDefined()
    await button(wrapper, '重新读取').trigger('click')
    const newer = ocrList(FILE_A.relPath, 'B窗口已保存')
    newer.pages[0]!.version = '101:2'
    ocr.get(FILE_A.relPath)!.resolve(newer)
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'A窗口编辑稿')
    expect(button(wrapper, '保存').attributes('disabled')).toBeUndefined()
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST').at(-1)?.[1])
      .toMatchObject({ body: { expectedVersion: '101:2', markdown: 'A窗口编辑稿' } })
  })

  it('删除409保留新结果，必须重新读取而非重试删除', async () => {
    const { wrapper, fetchMock, ocr, pdf } = await loadA()
    const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) => opts?.method === 'DELETE'
      ? Promise.reject({ status: 409 }) : original(url, opts))
    await chooseMenu(await openRowMenu(wrapper), '删除本页结果')
    await body().findAll('button').find((item) => item.text().trim() === '确认删除')!.trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE')?.[1])
      .toMatchObject({ query: { expectedVersion: '101:1', mode: 'versioned' } })
    expect(wrapper.text()).toContain('版本冲突')
    expect(button(wrapper, '重试删除')).toBeUndefined()
    await button(wrapper, '重新读取').trigger('click')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'B窗口的新结果'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(wrapper.text()).toContain('B窗口的新结果')
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')).toHaveLength(1)
  })

  it('已提交但读回内容缺失时禁止再次保存，重新读取保留草稿', async () => {
    const { wrapper, fetchMock, ocr, pdf } = await loadA()
    const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) => opts?.method === 'POST'
      ? Promise.resolve({}) : original(url, opts))
    await button(wrapper, '编辑').trigger('click')
    await wrapper.get('textarea').setValue('已经提交的稿')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    ocr.get(FILE_A.relPath)!.resolve({ count: 0, pages: [] })
    await flushPromises()
    expect(button(wrapper, '保存').attributes('disabled')).toBeDefined()
    expect(button(wrapper, '重试保存')).toBeUndefined()
    await button(wrapper, '重新读取').trigger('click')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '另一窗口替换的稿'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', '已经提交的稿')
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1)
  })
})

beforeEach(() => {
  vi.useRealTimers()
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return true
    },
  }))
})

afterEach(() => {
  harness?.wrapper.unmount()
  harness = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('B1 竞态：晚到的回包不许灌进新选的页面', () => {
  it('★ A 的页图与正文晚于 B 落地时，显示的仍是 B', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    await selectFile(wrapper, 'B-快')

    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 的第一页正文'))
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath))
    await flushPromises()
    expect(wrapper.text()).toContain('B 的第一页正文')

    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    expect(wrapper.text()).toContain('B 的第一页正文')
    expect(wrapper.text()).not.toContain('A 的第一页正文')
    expect(wrapper.text()).toContain('B-快.pdf')
  })

  it('★ 写在飞期间冻结文件切换', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('修改后')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(
      wrapper.get('button[aria-label="选择 PDF 文件"]').attributes('disabled'),
    ).toBeDefined()
  })
})

describe("渲染回包：晚到也不许换掉页图", () => {
  it('★ 渲染 A 期间切到 B，A 的渲染结果晚到后页面仍是 B', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr, render } = harness

    await selectFile(wrapper, 'A-慢')
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 1))
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    await flushPromises()

    const renderButton = wrapper
      .findAll('button')
      .find((item) => item.text().includes('渲染页图'))
    expect(renderButton, '未渲染时应给出「渲染页图」').toBeTruthy()
    await renderButton!.trigger('click')
    await flushPromises()

    await selectFile(wrapper, 'B-快')
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 3))
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 的第一页正文'))
    await flushPromises()
    expect(pageText(wrapper)).toContain('/ 3 页')

    render.get(FILE_A.relPath)!.resolve(renderOutcome(FILE_A.relPath, 1))
    await flushPromises()

    expect(wrapper.text()).toContain('B 的第一页正文')
    expect(pageText(wrapper)).toContain('/ 3 页')
    expect(wrapper.text()).not.toContain('A 的第一页正文')
  })
})

describe('B2 正文读不回来时不许充当空结果', () => {
  it('★ 清单里没有逐页正文 ⇒ 显示读不到、且没有任何可编辑的行', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, undefined))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    expect(wrapper.text()).toContain('读不到这份文件的结果')
    expect(wrapper.text()).toContain('逐页正文没读回来')
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('手工录入')
  })

  it('正文读回来了才给行', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.text()).toContain('A 的第一页正文')
    expect(wrapper.text()).toContain('有文本')
  })
})

describe('单页工作区与组合筛选', () => {
  it('97 页仅挂载当前页，状态并集与范围/正文交集保留实际页号', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr, router } = harness
    await selectFile(wrapper, 'A-慢')
    const response = ocrList(FILE_A.relPath, '宁波甲公司')
    response.pages.push({ ...response.pages[0]!, page: 3, markdown: '' })
    response.pages.push({
      ...response.pages[0]!,
      page: 8,
      markdown: '宁波乙公司',
    })
    response.count = 3
    ocr.get(FILE_A.relPath)!.resolve(response)
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 97))
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.text()).not.toContain('共 97 页')
    expect(pageText(wrapper)).toContain('第 1 / 97 页')

    const sheet = await setStates(wrapper, ['text', 'empty'])
    await sheet.get('input[aria-label="实际页号或范围"]').setValue('2-8')
    await applyFilters(wrapper)
    expect(wrapper.text()).toContain('命中 2 页')
    expect(pageText(wrapper)).toContain('第 3 / 97 页')
    expect(rows(wrapper)[0]!.text()).toContain('空结果')
    expect(rows(wrapper)[0]!.text()).toContain('正文为空')
    expect(wrapper.text()).toContain('定位到首个命中：第 3 页')

    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 8 / 97 页')
    expect(rows(wrapper)[0]!.text()).toContain('乙公司')

    const filters = await openFilters(wrapper)
    await filters.get('input[aria-label="当前文件正文关键词"]').setValue('乙')
    await applyFilters(wrapper)
    expect(pageText(wrapper)).toContain('第 8 / 97 页')

    await jumpTo(wrapper, '3')
    expect(body().text()).toContain('请输入当前命中范围内的实际页号')
    expect(pageText(wrapper)).toContain('第 8 / 97 页')

    const invalid = await openFilters(wrapper)
    await invalid.get('input[aria-label="实际页号或范围"]').setValue('8-2')
    const apply = body()
      .findAll('button')
      .find((item) => item.text().trim() === '应用筛选')!
    await apply.trigger('click')
    await flushPromises()
    expect(body().text()).toContain('页范围无效')
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()

    const empty = await openFilters(wrapper)
    await empty.get('input[aria-label="实际页号或范围"]').setValue('50-60')
    await applyFilters(wrapper)
    expect(wrapper.text()).toContain('没有命中页')
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.text().match(/清除页筛选/g)).toHaveLength(1)
    await button(wrapper, '清除页筛选').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)
    expect(pageText(wrapper)).toContain('第 1 / 97 页')
    expect(
      harness.fetchMock.mock.calls.filter(
        ([, opts]) => opts?.method === 'POST',
      ),
    ).toHaveLength(0)
  })
})

describe('URL 与视图', () => {
  it('URL 恢复文件、实际页、筛选和 view，前后导航保留其他查询', async () => {
    harness = await mountPage(
      `/ocr?file=${encodeURIComponent(FILE_A.relPath)}&page=4&states=text&range=1-8&text=公司&view=compare&returnTo=%2Ffiles`,
    )
    const { wrapper, pdf, ocr, router } = harness
    const response = ocrList(FILE_A.relPath, '甲公司')
    response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
    response.count = 2
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 8))
    ocr.get(FILE_A.relPath)!.resolve(response)
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 4 / 8 页')
    expect(wrapper.text()).toContain('关键词 公司')
    expect(
      wrapper
        .findAll('[data-slot="tabs-trigger"]')
        .find((tab) => tab.attributes('data-state') === 'active')
        ?.text(),
    ).toBe('对照')
    await button(wrapper, '上一页').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.page).toBe('1')
    router.back()
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 4 / 8 页')
    expect(router.currentRoute.value.query.returnTo).toBe('/files')
  })

  it('非法 view 回退文本，非法文件路径不选择也不请求', async () => {
    harness = await mountPage(
      '/ocr?file=../../other.pdf&page=-1&states=evil&source=evil&year=nope&view=evil',
    )
    expect(harness.wrapper.text()).toContain('选择一份 PDF 开始校对')
    expect(
      harness.wrapper
        .findAll('[data-slot="tabs-trigger"]')
        .find((tab) => tab.attributes('data-state') === 'active'),
    ).toBeUndefined()
    expect(
      harness.fetchMock.mock.calls.filter(
        ([url]) => url === '/api/ocr-results' || url === '/api/pdf-pages',
      ),
    ).toHaveLength(0)
  })

  it('窄屏视图切换写入/移除 view，文本为默认', async () => {
    const { wrapper, router } = await loadA()
    const imageTab = wrapper.findAll('[data-slot="tabs-trigger"]')[1]!
    await imageTab.trigger('mousedown', { button: 0 })
    await imageTab.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.view).toBe('image')
    const textTab = wrapper.findAll('[data-slot="tabs-trigger"]')[0]!
    await textTab.trigger('mousedown', { button: 0 })
    await textTab.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.view).toBeUndefined()
  })
})

describe('草稿保护与动作', () => {
  it('未保存草稿阻止换文件、换页、URL 返回和刷新，取消后恢复导航', async () => {
    const { wrapper, router, fetchMock } = await loadA()
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('尚未保存的甲公司修订')

    await selectFile(wrapper, 'B-快')
    expect(wrapper.text()).toContain('有未保存的草稿')
    expect(wrapper.get('textarea').element).toHaveProperty(
      'value',
      '尚未保存的甲公司修订',
    )
    expect(pageText(wrapper)).toContain('A-慢.pdf')

    expect(
      wrapper.get('button[aria-label="下一页"]').attributes('disabled'),
    ).toBeDefined()

    await router.push({
      path: '/ocr',
      query: { file: FILE_B.relPath, page: '1' },
    })
    await flushPromises()
    expect(router.currentRoute.value.query.file).toBe(FILE_A.relPath)

    const before = fetchMock.mock.calls.length
    const menu = await openWorkbenchMenu(wrapper)
    await chooseMenu(menu, '刷新文件与结果')
    expect(fetchMock.mock.calls).toHaveLength(before)

    await confirmDiscard(wrapper)
    expect(
      (document.activeElement as HTMLElement | null)?.closest(
        '[aria-label="翻页与页操作"]',
      ),
    ).not.toBeNull()
    await button(wrapper, '下一页').trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 4 页')
  })

  it('A→B→A 的首轮晚回包不覆盖新一轮 A 的页数与正文', async () => {
    harness = await mountPage()
    const { wrapper, ocr, pdf } = harness
    await selectFile(wrapper, 'A-慢')
    const oldOcr = ocr.get(FILE_A.relPath)!
    const oldPdf = pdf.get(FILE_A.relPath)!
    await selectFile(wrapper, 'B-快')
    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '新 A 正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 7))
    await flushPromises()
    oldOcr.resolve(ocrList(FILE_A.relPath, '旧 A 正文'))
    oldPdf.resolve(pagesState(FILE_A.relPath, 99))
    await flushPromises()
    expect(wrapper.text()).toContain('新 A 正文')
    expect(pageText(wrapper)).toContain('/ 7 页')
    expect(wrapper.text()).not.toContain('旧 A 正文')
  })

  it('空字符串保存使用捕获的文件/实际页，读回一致才退出编辑', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) =>
      opts?.method === 'POST' && url === '/api/ocr-results'
        ? Promise.resolve({ written: 1, pages: [1] })
        : original(url, opts),
    )
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    const post = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')!
    expect(post[1]).toMatchObject({
      body: { file: FILE_A.relPath, page: 1, markdown: '' },
    })
    expect(wrapper.text()).toContain('保存中')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, ''))
    await flushPromises()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(rows(wrapper)[0]!.text()).toContain('空结果')
    expect(wrapper.text()).toContain('正文为空')
    expect(wrapper.text()).toContain('保存完成')
  })

  it('提交失败与提交后读回失败均保留草稿，区分反馈并支持重试', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    let failWrite = true
    let failRead = false
    fetchMock.mockImplementation((url, opts) => {
      if (url === '/api/ocr-results' && opts?.method === 'POST') {
        if (failWrite) return Promise.reject(new Error('保存失败,请重试。'))
        return Promise.resolve({ written: 1, pages: [1] })
      }
      if (url === '/api/ocr-results' && failRead)
        return Promise.reject(new Error('写入已提交,但读回失败'))
      return original(url, opts)
    })
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('校对后正文')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('保存失败')
    expect(wrapper.get('textarea').element).toHaveProperty('value', '校对后正文')

    failWrite = false
    failRead = true
    await wrapper.findAll('button').find((item) => item.text().trim() === '重试保存')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('写入已提交,但读回失败')
    expect(wrapper.get('textarea').element).toHaveProperty('value', '校对后正文')

    failRead = false
    await button(wrapper, '重试读取').trigger('click')
    await flushPromises()
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '校对后正文'))
    harness!.pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(rows(wrapper)[0]!.text()).toContain('校对后正文')
  })

  it('读回不一致且新正文不匹配筛选时仍保留当前页草稿', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    const filters = await openFilters(wrapper)
    await filters.get('input[aria-label="当前文件正文关键词"]').setValue('甲公司')
    await applyFilters(wrapper)
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) =>
      opts?.method === 'POST' ? Promise.resolve({}) : original(url, opts),
    )
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('甲公司人工校对')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '不同的内容'))
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty(
      'value',
      '甲公司人工校对',
    )
    expect(pageText(wrapper)).toContain('第 1 / 4 页')
    expect(wrapper.text()).toContain('有未保存的草稿')
  })

  it('逐页删除必须确认，取消不写，确认仅删当前实际页并读回', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) =>
      opts?.method === 'DELETE'
        ? Promise.resolve({ deleted: 1, remaining: 0 })
        : original(url, opts),
    )
    const menu = await openRowMenu(wrapper)
    await chooseMenu(menu, '删除本页结果')
    expect(
      fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE'),
    ).toHaveLength(0)
    const cancel = body()
      .findAll('button')
      .find((item) => item.text().trim() === '取消')!
    await cancel.trigger('click')
    await flushPromises()

    const again = await openRowMenu(wrapper)
    await chooseMenu(again, '删除本页结果')
    const confirm = body()
      .findAll('button')
      .find((item) => item.text().trim() === '确认删除')!
    await confirm.trigger('click')
    await flushPromises()
    expect(
      fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE')?.[1],
    ).toMatchObject({ query: { file: FILE_A.relPath, page: 1 } })
    ocr.get(FILE_A.relPath)!.resolve({ count: 0, pages: [] })
    await flushPromises()
    // 焦点回归是异步的（请求收尾 → nextTick → focusBar，且弹层关闭还会回焦一次）。
    // 用可观察的等待代替固定 setTimeout，避免并行负载下的偶发失败。
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('已删除第 1 页')
      expect(rows(wrapper)[0]!.text()).toContain('未识别')
      expect(wrapper.text()).toContain('手工录入')
      const active = document.activeElement as HTMLElement | null
      const info = {
        inBar: !!active?.closest('[aria-label="翻页与页操作"]'),
        tag: active?.tagName ?? null,
        aria: active?.getAttribute?.('aria-label') ?? null,
        text: active?.textContent?.trim().slice(0, 24) ?? null,
        dialogOpen: !!document.querySelector('[data-slot="dialog-content"]'),
        focusGuards: document.querySelectorAll('[data-reka-focus-guard]')
          .length,
      }
      expect(info.inBar, JSON.stringify(info)).toBe(true)
    })
  })

  it('刷新失败保留同文件内容并关闭写入，重试恢复', async () => {
    const { wrapper, fetchMock, ocr, pdf } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    let fail = true
    fetchMock.mockImplementation((url, opts) =>
      url === '/api/ocr-results' && fail
        ? Promise.reject(new Error('合成断网'))
        : original(url, opts),
    )
    const menu = await openWorkbenchMenu(wrapper)
    await chooseMenu(menu, '刷新文件与结果')
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(rows(wrapper)[0]!.text()).toContain('甲公司')
    expect(wrapper.text()).toContain('读不到这份文件的页图与识别结果。')
    expect(
      wrapper.get('button[aria-label="编辑"]').attributes('disabled'),
    ).toBeDefined()
    fail = false
    await button(wrapper, '重试读取').trigger('click')
    await flushPromises()
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '重试后的甲公司'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(rows(wrapper)[0]!.text()).toContain('重试后的甲公司')
    expect(
      wrapper.get('button[aria-label="编辑"]').attributes('disabled'),
    ).toBeUndefined()
  })
})

describe('文件选择与导入', () => {
  it('文件名、来源、公布年组合过滤并清除，不另发每文件 OCR 请求且保留当前工作区', async () => {
    const { wrapper, router, fetchMock } = await loadA()
    const sheet = await openFileSheet(wrapper)
    await sheet.get('input[aria-label="按文件名搜索"]').setValue('A-慢')
    await flushPromises()
    expect(body().text()).toContain('匹配 1 / 2 份 PDF')
    // 当前文件固定置顶（不是列表按钮），搜索过滤后仍必须可见。
    expect(body().text()).toContain('当前文件')
    expect(body().text()).toContain('A-慢.pdf')

    await router.replace({
      query: { ...router.currentRoute.value.query, source: 'miit', year: '2023' },
    })
    await flushPromises()
    expect(body().text()).toContain('匹配 0 / 2 份 PDF')
    expect(body().text()).toContain('当前文件不在筛选结果中')
    expect(rows(wrapper)[0]!.text()).toContain('甲公司')

    const clear = body()
      .findAll('button')
      .find((item) => item.text().includes('清除文件筛选'))!
    await clear.trigger('click')
    await flushPromises()
    expect(body().text()).toContain('匹配 2 / 2 份 PDF')
    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/ocr-results'),
    ).toHaveLength(1)
  })

  it('导入沿用原始正文与页标记，读回核对并显示回执', async () => {
    const { wrapper, fetchMock, ocr } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    fetchMock.mockImplementation((url, opts) =>
      opts?.method === 'POST'
        ? Promise.resolve({ written: 1, pages: [4], warning: null })
        : original(url, opts),
    )
    const menu = await openWorkbenchMenu(wrapper)
    await chooseMenu(menu, '导入识别结果')
    const markdownTab = body()
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === 'Markdown')!
    await markdownTab.trigger('mousedown', { button: 0 })
    await markdownTab.trigger('click')
    await flushPromises()
    const source = '<!-- page: 4 -->\n\n人工导入第四页'
    await body().get('#ocr-import-markdown').setValue(source)
    const submit =
      body()
        .findAll('button')
        .find((item) => item.text().includes('导入') && item.text().includes('写入')) ??
      body()
        .findAll('button')
        .find((item) => item.text().trim() === '导入')!
    await submit.trigger('click')
    await flushPromises()
    expect(
      fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')?.[1],
    ).toMatchObject({ body: { file: FILE_A.relPath, markdown: source, page: null } })
    ocr.get(FILE_A.relPath)!.resolve({
      count: 1,
      pages: [{ ...ocrList(FILE_A.relPath, '').pages[0]!, page: 4, markdown: source }],
    })
    await flushPromises()
    expect(wrapper.text()).toContain('导入完成')
    expect(wrapper.text()).toContain('已写入 1 页(第 4 页)')
    expect(wrapper.text()).toContain('读回一致')
  })

  it('非法文件路径不选择也不请求', async () => {
    harness = await mountPage('/ocr?file=../../other.pdf&page=-1')
    expect(harness.wrapper.text()).toContain('选择一份 PDF 开始校对')
    expect(
      harness.fetchMock.mock.calls.filter(
        ([url]) => url === '/api/ocr-results' || url === '/api/pdf-pages',
      ),
    ).toHaveLength(0)
  })
})

describe('阅读、源码与编辑', () => {
  it('阅读默认渲染、源码可切换、换行可达、复制失败不改状态，编辑取原始 Markdown', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness
    const source =
      '# 原始名单\n\n<table><tr><th colspan="2">公布名单</th></tr><tr><td rowspan="2">宁波甲公司</td><td>2026</td></tr><tr><td>复核</td></tr></table>'
    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, source))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 2))
    await flushPromises()

    expect(rows(wrapper)[0]!.get('td[rowspan="2"]').text()).toBe('宁波甲公司')
    expect(wrapper.text()).not.toContain('Markdown 文档 · markdown')
    expect(wrapper.text()).not.toContain('原始 file')

    await button(wrapper, '源码').trigger('click')
    await flushPromises()
    expect(wrapper.get('pre').text()).toContain('<table>')
    expect(wrapper.find('.code-preview').classes()).toContain('wrap-code')
    await button(wrapper, '自动换行').trigger('click')
    await flushPromises()
    expect(wrapper.find('.code-preview').classes()).not.toContain('wrap-code')

    await wrapper.get('button[aria-label="复制原文"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('复制失败')

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', source)
    await wrapper.get('textarea').setValue(source + '\n校对草稿')
    await confirmDiscard(wrapper)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(
      (document.activeElement as HTMLElement | null)?.closest(
        '[aria-label="翻页与页操作"]',
      ),
    ).not.toBeNull()

    await selectFile(wrapper, 'B-快')
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 2))
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, '第二文件'))
    await flushPromises()
    expect(wrapper.text()).toContain('第二文件')
    expect(wrapper.text()).not.toContain('原始名单')
  })

  it('空结果与未识别保持不同，97 页只挂载当前页', async () => {
    const { wrapper } = await loadA(97)
    expect(rows(wrapper)).toHaveLength(1)
    await jumpTo(wrapper, '2')
    expect(rows(wrapper)[0]!.text()).toContain('空结果')
    expect(rows(wrapper)[0]!.text()).toContain('正文为空')
    await jumpTo(wrapper, '97')
    expect(rows(wrapper)[0]!.text()).toContain('未识别')
    expect(rows(wrapper)[0]!.text()).toContain('这一页还没有识别文本')
    expect(wrapper.find('[aria-label="正文预览操作"]').exists()).toBe(false)
  })

  it('翻页重置 pane scrollTop、不滚文档，键盘 ←/→ 可用且输入/编辑时不触发', async () => {
    const { wrapper, router } = await loadA(4, '甲公司', '第二页正文')
    const pane = wrapper.get('.preview-content').element as HTMLElement
    pane.scrollTop = 120
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 4 页')
    expect(router.currentRoute.value.query.page).toBe('2')
    expect(window.scrollY).toBe(0)
    expect(
      (wrapper.get('.preview-content').element as HTMLElement).scrollTop,
    ).toBe(0)

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    ;(wrapper.get('textarea').element as HTMLTextAreaElement).focus()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 4 页')

    await button(wrapper, '取消').trigger('click')
    await flushPromises()
    const filters = await openFilters(wrapper)
    const input = filters.get('input[aria-label="当前文件正文关键词"]')
    ;(input.element as HTMLInputElement).focus()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 4 页')
  })
})

describe('唯一翻页器与焦点', () => {
  it('底栏只有一个上一页/下一页，没有第二套筛选控件', async () => {
    const { wrapper } = await loadA(4)
    expect(wrapper.findAll('button[aria-label="上一页"]')).toHaveLength(1)
    expect(wrapper.findAll('button[aria-label="下一页"]')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('上一处')
    expect(wrapper.text()).not.toContain('下一处')
    expect(document.querySelectorAll('#ocr-range')).toHaveLength(0)
    expect(document.querySelectorAll('#ocr-state-text')).toHaveLength(0)

    const filters = await openFilters(wrapper)
    expect(filters.findAll('#ocr-range')).toHaveLength(1)
    expect(filters.findAll('#ocr-state-text')).toHaveLength(1)
    await filters.findAll('button').find((b) => b.text().trim() === '取消')!.trigger('click')
    await flushPromises()

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    expect(
      wrapper.get('button[aria-label="下一页"]').attributes('disabled'),
    ).toBeDefined()
    expect(
      wrapper.get('button[aria-label="上一页"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('保存使当前页退出正文筛选后焦点落在底栏；另一命中页或空结果都可继续', async () => {
    for (const another of [true, false]) {
      const harnessLocal = await mountPage()
      const { wrapper, pdf, ocr, fetchMock } = harnessLocal
      await selectFile(wrapper, 'A-慢')
      const response = ocrList(FILE_A.relPath, '甲公司')
      response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
      response.count = 2
      ocr.get(FILE_A.relPath)!.resolve(response)
      pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
      await flushPromises()

      const filters = await openFilters(wrapper)
      await filters.get('input[aria-label="当前文件正文关键词"]').setValue('公司')
      await applyFilters(wrapper)
      expect(pageText(wrapper)).toContain('第 1 / 4 页')

      const original = fetchMock.getMockImplementation()! as (
        url: string,
        opts?: unknown,
      ) => Promise<unknown>
      fetchMock.mockImplementation((url, opts) =>
        opts?.method === 'POST'
          ? Promise.resolve({ written: 1, pages: [1] })
          : original(url, opts),
      )
      await button(wrapper, '编辑').trigger('click')
      await flushPromises()
      await wrapper.get('textarea').setValue('修订完成')
      await button(wrapper, '保存').trigger('click')
      await flushPromises()
      const next = ocrList(FILE_A.relPath, '修订完成')
      if (another)
        next.pages.push({ ...next.pages[0]!, page: 4, markdown: '乙公司' })
      next.count = another ? 2 : 1
      ocr.get(FILE_A.relPath)!.resolve(next)
      await flushPromises()

      expect(
        (document.activeElement as HTMLElement | null)?.closest(
          '[aria-label="翻页与页操作"]',
        ),
      ).not.toBeNull()
      if (another) expect(pageText(wrapper)).toContain('第 4 / 4 页')
      else {
        expect(wrapper.text()).toContain('没有命中页')
        expect(wrapper.text()).toContain('清除页筛选')
      }
      wrapper.unmount()
      harness = null
      document.body.innerHTML = ''
      vi.unstubAllGlobals()
    }
    harness = null
  })

  it('老文件失败晚回包不替换新文件成功正文', async () => {
    harness = await mountPage()
    const { wrapper, ocr, pdf } = harness
    await selectFile(wrapper, 'A-慢')
    const oldOcr = ocr.get(FILE_A.relPath)!
    const oldPdf = pdf.get(FILE_A.relPath)!
    await selectFile(wrapper, 'B-快')
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 3))
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 已成功'))
    await flushPromises()
    oldOcr.reject(new Error('旧文件读失败'))
    oldPdf.reject(new Error('旧文件读失败'))
    await flushPromises()
    expect(rows(wrapper)[0]!.text()).toContain('B 已成功')
    expect(pageText(wrapper)).toContain('/ 3 页')
    expect(wrapper.text()).not.toContain('读不到这份文件的结果')
    expect(
      wrapper.get('button[aria-label="编辑"]').attributes('disabled'),
    ).toBeUndefined()
  })
})

/**
 * R2 回归：评审确认的行为空洞。这些用例按「用户可见入口 → 可观察结果」写，
 * 覆盖对照弹窗安全渲染/精确复制、HTML 事件属性清洗、主题跟随、
 * 读回缺失的重试分派、键盘横向滚动、以及脏草稿取消确认。
 */
describe("复核回归", () => {
  it('提交成功但读回缺少逐页正文：保留可选草稿，重试只发 GET，恢复后正常结束编辑', async () => {
    const { wrapper, fetchMock } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    let posts = 0
    fetchMock.mockImplementation((url, opts) => {
      const options = opts as { method?: string } | undefined
      if (url === '/api/ocr-results' && options?.method === 'POST') {
        posts += 1
        return Promise.resolve({ written: 1, pages: [1] })
      }
      return original(url, opts)
    })

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('需要确认的人工修订')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    harness!.ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, undefined))
    await flushPromises()

    expect(wrapper.text()).toContain('写入已提交,但读回失败')
    const textarea = wrapper.get('textarea')
    expect(textarea.element).toHaveProperty('value', '需要确认的人工修订')
    // The draft stays editable/selectable: detailError is not a write in flight.
    expect(textarea.attributes('disabled')).toBeUndefined()
    expect(textarea.attributes('readonly')).toBeUndefined()

    const retryRead = wrapper
      .findAll('button')
      .find((item) => item.text().trim() === '重试读取')
    expect(retryRead, '读回缺失必须给出「重试读取」').toBeTruthy()
    await retryRead!.trigger('click')
    await flushPromises()
    harness!.pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    harness!.ocr
      .get(FILE_A.relPath)!
      .resolve(ocrList(FILE_A.relPath, '需要确认的人工修订'))
    await flushPromises()

    expect(posts).toBe(1)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(rows(wrapper)[0]!.text()).toContain('需要确认的人工修订')
    expect(wrapper.text()).toContain('保存完成')
  })

  it('删除失败先重新确认；已提交但读回失败只重读，不重复 DELETE', async () => {
    const { wrapper, fetchMock } = await loadA()
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      opts?: unknown,
    ) => Promise<unknown>
    let failDelete = true
    let failCommittedRead = false
    fetchMock.mockImplementation((url, opts) => {
      const options = opts as { method?: string } | undefined
      if (url === '/api/ocr-results' && options?.method === 'DELETE') {
        if (failDelete) return Promise.reject(new Error('删除失败,请重试。'))
        return Promise.resolve({ deleted: 1, remaining: 0 })
      }
      if (url === '/api/ocr-results' && !options?.method && failCommittedRead) {
        failCommittedRead = false
        return Promise.reject(new Error('读回断网'))
      }
      return original(url, opts)
    })

    const menu = await openRowMenu(wrapper)
    await chooseMenu(menu, '删除本页结果')
    await body()
      .findAll('button')
      .find((item) => item.text().trim() === '确认删除')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('删除失败')
    const retryDelete = wrapper
      .findAll('button')
      .find((item) => item.text().trim() === '重试删除')
    expect(retryDelete, '未提交的删除失败应给出「重试删除」').toBeTruthy()

    // Retry must not silently re-issue DELETE: it opens the confirmation again.
    const deletesBefore = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as { method?: string } | undefined)?.method === 'DELETE',
    ).length
    await retryDelete!.trigger('click')
    await flushPromises()
    expect(body().text()).toContain('删除这一页的识别结果？')
    await body()
      .findAll('button')
      .find((item) => item.text().trim() === '取消')!
      .trigger('click')
    await flushPromises()
    expect(
      fetchMock.mock.calls.filter(
        ([, opts]) => (opts as { method?: string } | undefined)?.method === 'DELETE',
      ).length,
    ).toBe(deletesBefore)

    // Committed DELETE whose readback failed: the retry is read-only.
    failDelete = false
    failCommittedRead = true
    await button(wrapper, '重试删除').trigger('click')
    await flushPromises()
    await body()
      .findAll('button')
      .find((item) => item.text().trim() === '确认删除')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('删除已提交,但读回失败')
    const deleteCount = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as { method?: string } | undefined)?.method === 'DELETE',
    ).length
    await button(wrapper, '重试读取').trigger('click')
    await flushPromises()
    harness!.ocr.get(FILE_A.relPath)!.resolve({ count: 0, pages: [] })
    harness!.pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
    await flushPromises()
    expect(
      fetchMock.mock.calls.filter(
        ([, opts]) => (opts as { method?: string } | undefined)?.method === 'DELETE',
      ).length,
    ).toBe(deleteCount)
    expect(rows(wrapper)[0]!.text()).toContain('未识别')
  })

  it('主区与同页对照共用安全表格与精确源码复制，显示操作不写入', async () => {
    const source =
      '# 原始名单\r\n\r\n<table><tr><td rowspan="2">宁波甲公司</td><td>2026</td></tr><tr><td>合并名单</td></tr></table>\r\n\r\n- 原始条目\r\n'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    harness = await mountPage()
    const { wrapper, pdf, ocr, fetchMock } = harness
    await selectFile(wrapper, 'A-慢')
    const response = ocrList(FILE_A.relPath, source)
    ocr.get(FILE_A.relPath)!.resolve(response)
    pdf
      .get(FILE_A.relPath)!
      .resolve({
        ...pagesState(FILE_A.relPath),
        pages: [{ page: 1, url: '/api/files/synthetic/page-1.png' }],
      })
    await flushPromises()

    expect(rows(wrapper)[0]!.get('h1').text()).toBe('原始名单')
    expect(rows(wrapper)[0]!.get('td[rowspan="2"]').text()).toBe('宁波甲公司')

    await button(wrapper, '源码').trigger('click')
    await flushPromises()
    expect(
      rows(wrapper)[0]!.get('pre').element.textContent!.replace(/\r\n/g, '\n'),
    ).toBe(source.replace(/\r\n/g, '\n'))
    await wrapper.get('button[aria-label="复制原文"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith(source)

    await wrapper.get('[aria-label="放大看第 1 页"]').trigger('click')
    await flushPromises()
    const dialog = body().get('[data-slot="dialog-content"]')
    expect(dialog.get('td[rowspan="2"]').text()).toBe('宁波甲公司')
    await dialog
      .findAll('button')
      .find((item) => item.text().trim() === '源码')!
      .trigger('click')
    await flushPromises()
    expect(
      dialog.get('pre').element.textContent!.replace(/\r\n/g, '\n'),
    ).toBe(source.replace(/\r\n/g, '\n'))
    await dialog.get('[aria-label="复制对照原文"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith(source)

    expect(
      fetchMock.mock.calls.filter(
        ([, options]) =>
          (options as { method?: string } | undefined)?.method &&
          (options as { method?: string }).method !== 'GET',
      ),
    ).toEqual([])
    expect(response.pages[0]!.markdown).toBe(source)
  })

  it('渲染结果清除行内事件属性，编辑仍取原始 Markdown', async () => {
    const source =
      '# 标题\n\n<table><tr><td onclick="alert(1)">企业甲</td></tr></table>\n'
    const { wrapper, fetchMock } = await loadA(4, source)
    expect(rows(wrapper)[0]!.find('[onclick]').exists()).toBe(false)
    expect(rows(wrapper)[0]!.get('td').text()).toBe('企业甲')

    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', source)
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST'),
    ).toEqual([])
  })

  it('OCR 主区跟随应用主题，换文件重置源码视图与复制提示', async () => {
    const ThemeToggle = (await import('../../../components/ThemeToggle.vue')).default
    const toggle = mount(ThemeToggle)
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      })
      const { wrapper, pdf, ocr } = await loadA(1, '# 甲文件正文')
      const themeBefore = rows(wrapper)[0]!
        .get('[data-theme]')
        .attributes('data-theme')
      await toggle.get('button').trigger('click')
      await flushPromises()
      expect(
        rows(wrapper)[0]!.get('[data-theme]').attributes('data-theme'),
      ).toBe(themeBefore === 'dark' ? 'light' : 'dark')

      await button(wrapper, '源码').trigger('click')
      await wrapper.get('button[aria-label="复制原文"]').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('已复制原文')

      await selectFile(wrapper, 'B-快')
      pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 1))
      ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, '# B 的新正文'))
      await flushPromises()
      expect(rows(wrapper)[0]!.get('h1').text()).toBe('B 的新正文')
      // New file ⇒ new page row ⇒ rendered view again, not the old source view.
      expect(wrapper.find('pre').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('已复制原文')
      expect(wrapper.text()).not.toContain('甲文件正文')
    } finally {
      await toggle.get('button').trigger('click')
      toggle.unmount()
    }
  })

  it('横向滚动内容可获得焦点并保留 ←/→，全局翻页只作用于非交互焦点', async () => {
    const wideTable =
      '# 长表\n\n<table><tr>' +
      Array.from({ length: 18 }, (_, index) => `<th>字段${index}</th>`).join('') +
      '</tr><tr>' +
      Array.from({ length: 18 }, () => '<td>值</td>').join('') +
      '</tr></table>\n'
    const { wrapper } = await loadA(4, wideTable)
    const scroller = wrapper.get('.safe-preview-html').element as HTMLElement
    expect(scroller.getAttribute('tabindex')).toBe('0')
    expect(scroller.getAttribute('role')).toBe('region')
    expect(scroller.getAttribute('aria-label')).toContain('横向滚动')
    Object.defineProperty(scroller, 'scrollWidth', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true })
    scroller.focus()
    const key = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })
    scroller.dispatchEvent(key)
    await flushPromises()
    expect(key.defaultPrevented).toBe(false)
    expect(pageText(wrapper)).toContain('第 1 / 4 页')

    // A non-interactive target still pages.
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 4 页')
  })

  it('有改动时取消/Esc 先确认；未改动直接退出；拒绝放弃保留草稿与焦点', async () => {
    const { wrapper } = await loadA()
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    const editor = wrapper.get('textarea').element as HTMLTextAreaElement
    // Entry focus is frame-based. Wait for the observable fresh-edit state
    // (focused, caret at the head) before placing the user's caret; a person
    // cannot select text before that entry intent has settled.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(editor)
      expect(editor.selectionStart).toBe(0)
      expect(editor.selectionEnd).toBe(0)
    })
    await wrapper.get('textarea').setValue('未保存修订')
    editor.focus()
    // Returning from the confirmation keeps the caret place, not 0,0.
    editor.setSelectionRange(1, 4)
    editor.dispatchEvent(new Event('select', { bubbles: true }))

    await wrapper
      .get('.ocr-workbench')
      .trigger('keydown', { key: 'Escape' })
    await flushPromises()
    let dialog = body().get('[data-slot="dialog-content"]')
    expect(dialog.text()).toContain('放弃未保存的校对')
    await dialog
      .findAll('button')
      .find((item) => item.text().trim() === '继续编辑')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.get('textarea').element).toHaveProperty('value', '未保存修订')
    // The return-to-caret restore is also frame-based; assert the settled,
    // user-observable outcome (focus + selection), not an intermediate frame.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(wrapper.get('textarea').element)
      expect(editor.selectionStart).toBe(1)
      expect(editor.selectionEnd).toBe(4)
    })

    await button(wrapper, '取消').trigger('click')
    await flushPromises()
    dialog = body().get('[data-slot="dialog-content"]')
    await dialog
      .findAll('button')
      .find((item) => item.text().trim() === '放弃草稿')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(
      (document.activeElement as HTMLElement | null)?.closest(
        '[aria-label="翻页与页操作"]',
      ),
    ).not.toBeNull()

    // A clean edit exits without any dialog.
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await button(wrapper, '取消').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('文件 Sheet 被草稿守卫拒绝时保持打开并说明原因', async () => {
    const { wrapper } = await loadA()
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('未保存修订')
    const sheet = await openFileSheet(wrapper)
    expect(sheet.text()).toContain('有未保存的草稿')
    const row = sheet
      .findAll('[data-slot="sheet-content"] li button')
      .find((item) => item.text().includes('B-快'))!
    expect(row.attributes('disabled')).toBeDefined()
    await row.trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
    expect(wrapper.get('textarea').element).toHaveProperty('value', '未保存修订')
    expect(pageText(wrapper)).toContain('A-慢.pdf')
  })
})

describe('编辑焦点所有权', () => {
  it('旧 focus 请求被新意图取代后，其续体不得改回新的 caret', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })

    const row: WorkbenchRow = {
      page: 1,
      image: null,
      result: {
        page: 1,
        markdown: '原文内容甲乙丙',
        pageRelPath: null,
        engine: 'paddleocr',
        model: null,
        channel: 'upload',
        createdAt: '2026-10-15T00:00:00.000Z',
      },
    }
    const wrapper = mount(OcrPageRow, {
      attachTo: document.body,
      props: {
        row,
        filePath: 'a.pdf',
        editing: true,
        draft: '原文内容甲乙丙',
        view: 'text',
      },
    })
    try {
      const textarea = wrapper.get('textarea').element as HTMLTextAreaElement
      textarea.focus()
      textarea.setSelectionRange(1, 4)
      textarea.dispatchEvent(new Event('select', { bubbles: true }))

      const exposed = wrapper.vm as unknown as {
        focusEditor: (reset?: boolean) => void
      }
      // 旧的「新进编辑回到文首」请求，随后被「回到原 caret」的新意图取代。
      exposed.focusEditor(true)
      exposed.focusEditor(false)
      await flushPromises()
      expect(frames).toHaveLength(2)

      // 新意图先落地：聚焦 + 恢复 1..4。
      frames[1]!(0)
      await flushPromises()
      expect(document.activeElement).toBe(textarea)
      expect(textarea.selectionStart).toBe(1)

      // 被取代的旧请求迟到时必须放弃自己的续体，不能把 caret 改回 0。
      frames[0]!(0)
      await flushPromises()
      expect(textarea.selectionStart).toBe(1)
      expect(textarea.selectionEnd).toBe(4)
    } finally {
      wrapper.unmount()
    }
  })
})

describe("快速页面导航", () => {
  it('入口直接列页：点第 3 页即跳转，当前页与三档状态可读', async () => {
    const { wrapper, router } = await loadA(12, '甲公司', '', [1, 2, 3])
    const panel = await openPageNav(wrapper)
    expect(panel.get('[data-ocr-page-nav-summary]').text()).toContain(
      '全文件 12 页',
    )
    expect(pageCells()).toHaveLength(12)

    const current = panel.get('[data-ocr-page-cell][aria-current="page"]')
    expect(current.attributes('data-page')).toBe('1')
    expect(current.attributes('aria-label')).toContain('当前页')
    expect(current.attributes('aria-label')).toContain('有文本')
    expect(current.attributes('tabindex')).toBe('0')

    const third = panel.get('[data-ocr-page-cell][data-page="3"]')
    expect(third.attributes('tabindex')).toBe('-1')
    await third.trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 3 / 12 页')
    expect(router.currentRoute.value.query.page).toBe('3')
    expect(
      panel
        .get('[data-ocr-page-cell][data-page="3"]')
        .attributes('aria-current'),
    ).toBe('page')
    expect(
      panel
        .get('[data-ocr-page-cell][data-page="2"]')
        .attributes('aria-label'),
    ).toContain('空结果')
    expect(
      panel
        .get('[data-ocr-page-cell][data-page="5"]')
        .attributes('aria-label'),
    ).toContain('未识别')
  })

  it('缩略图只为已有页图的页挂 img，缺图页仍可点选', async () => {
    const { wrapper } = await loadA(6, '甲公司', '', [1, 2])
    const panel = await openPageNav(wrapper)
    expect(panel.findAll('[data-ocr-page-cell] img')).toHaveLength(2)
    const missing = panel.get('[data-ocr-page-cell][data-page="5"]')
    expect(missing.text()).toContain('无页图')
    await missing.trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 5 / 6 页')
  })

  it('筛选时只列命中实际页；清除筛选是显式动作', async () => {
    const { wrapper, router } = await loadA(97)
    const sheet = await openFilters(wrapper)
    await sheet.get('input[aria-label="实际页号或范围"]').setValue('2-4')
    await applyFilters(wrapper)
    expect(pageText(wrapper)).toContain('第 2 / 97 页')

    const panel = await openPageNav(wrapper)
    expect(pageCells()).toHaveLength(3)
    expect(pageCells().map((cell) => cell.attributes('data-page'))).toEqual([
      '2',
      '3',
      '4',
    ])
    expect(panel.text()).toContain('当前命中 3 页')
    expect(panel.find('[data-ocr-page-cell][data-page="1"]').exists()).toBe(
      false,
    )

    const clear = panel
      .findAll('button')
      .find((item) => item.text().includes('清除页筛选'))!
    await clear.trigger('click')
    await flushPromises()
    expect(pageCells()).toHaveLength(97)
    expect(pageText(wrapper)).toContain('第 2 / 97 页')
    expect(router.currentRoute.value.query.range).toBeUndefined()
  })

  it('有未保存草稿时页格不接受跳转，并说明原因', async () => {
    const { wrapper } = await loadA(6)
    await button(wrapper, '编辑').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('未保存修订')
    // 进入编辑后的 focus 回归要跑几帧；等编辑器真正拿到焦点（可观察状态）再开面板，
    // 避免把「焦点被编辑器拉回去」误判成面板自己关闭。
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(wrapper.get('textarea').element),
    )

    const panel = await openPageNav(wrapper)
    expect(panel.text()).toContain('有未保存的草稿')
    const cell = panel.get('[data-ocr-page-cell][data-page="3"]')
    expect(cell.attributes('aria-disabled')).toBe('true')
    await cell.trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 1 / 6 页')
    expect(wrapper.get('textarea').element).toHaveProperty(
      'value',
      '未保存修订',
    )
  })

  it('方向键在页面网格内移动焦点', async () => {
    const { wrapper } = await loadA(12)
    const panel = await openPageNav(wrapper)
    const first = panel.get('[data-ocr-page-cell][data-page="1"]')
    ;(first.element as HTMLElement).focus()
    await first.trigger('keydown', { key: 'ArrowRight' })
    expect((document.activeElement as HTMLElement).dataset.page).toBe('2')
    await new DOMWrapper(document.activeElement as HTMLElement).trigger(
      'keydown',
      { key: 'ArrowDown' },
    )
    expect((document.activeElement as HTMLElement).dataset.page).toBe('7')
    await new DOMWrapper(document.activeElement as HTMLElement).trigger(
      'keydown',
      { key: 'End' },
    )
    expect((document.activeElement as HTMLElement).dataset.page).toBe('12')
    await new DOMWrapper(document.activeElement as HTMLElement).trigger(
      'keydown',
      { key: 'Home' },
    )
    expect((document.activeElement as HTMLElement).dataset.page).toBe('1')
  })

  it('点过底栏下一页后，←/→ 仍继续翻页；文本输入内不触发', async () => {
    const { wrapper } = await loadA(6)
    const next = wrapper
      .findAll('button')
      .find((item) => item.attributes('aria-label') === '下一页')!
    ;(next.element as HTMLElement).focus()
    await next.trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 2 / 6 页')
    // 真实键盘事件从焦点按钮冒泡到 window；按钮不消费方向键。
    ;(next.element as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 3 / 6 页')

    // 第 3 页没有识别结果，编辑入口写作「手工录入」。
    await wrapper.get('button[aria-label="手工录入"]').trigger('click')
    await flushPromises()
    ;(wrapper.get('textarea').element as HTMLTextAreaElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 3 / 6 页')
  })

  it('移动端用底部 Sheet：点页后面板关闭、焦点回到页号入口', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      media,
      matches: true,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return true
      },
    }))
    const { wrapper } = await loadA(6)
    const trigger = wrapper.get('button[aria-label="跳转实际页号"]')
    await trigger.trigger('click')
    await flushPromises()
    const sheet = body().get('[data-slot="sheet-content"]')
    expect(sheet.text()).toContain('页面导航')
    await sheet.get('[data-ocr-page-cell][data-page="4"]').trigger('click')
    await flushPromises()
    expect(pageText(wrapper)).toContain('第 4 / 6 页')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element))
  })
})
