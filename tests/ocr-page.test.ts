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
import OcrPage from '../pages/ocr.vue'

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
  await wrapper.get('button[aria-label="跳转实际页号"]').trigger('click')
  await flushPromises()
  const sheet = body()
  const input = sheet.get('input[aria-label="跳转实际页号"]')
  await input.setValue(value)
  const submit = sheet
    .findAll('button')
    .find((item) => item.text().trim() === '跳转')!
  await submit.trigger('click')
  await flushPromises()
}

function rows(wrapper: Harness['wrapper']) {
  return wrapper.findAll('ul[role="list"] li')
}

function button(wrapper: Harness['wrapper'], text: string) {
  return wrapper.findAll('button').find((item) => item.text().trim() === text)!
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

async function loadA(pageCount = 4, markdown = '甲公司', page2Markdown = '') {
  harness = await mountPage()
  await selectFile(harness.wrapper, 'A-慢')
  const response = ocrList(FILE_A.relPath, markdown)
  response.pages.push({ ...response.pages[0]!, page: 2, markdown: page2Markdown })
  response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
  response.count = 3
  harness.ocr.get(FILE_A.relPath)!.resolve(response)
  harness.pdf
    .get(FILE_A.relPath)!
    .resolve(pagesState(FILE_A.relPath, pageCount))
  await flushPromises()
  return harness
}

let harness: Harness | null = null

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

describe('R1 渲染回包：晚到也不许换掉页图', () => {
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
    expect(wrapper.text()).toContain('共 3 页')

    render.get(FILE_A.relPath)!.resolve(renderOutcome(FILE_A.relPath, 1))
    await flushPromises()

    expect(wrapper.text()).toContain('B 的第一页正文')
    expect(wrapper.text()).toContain('共 3 页')
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
    expect(wrapper.text()).toContain('共 97 页')
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

    await button(wrapper, '取消').trigger('click')
    await flushPromises()
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
    expect(wrapper.text()).toContain('共 7 页')
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
    await wrapper.findAll('button').find((item) => item.text().trim() === '重试')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('写入已提交,但读回失败')
    expect(wrapper.get('textarea').element).toHaveProperty('value', '校对后正文')

    failRead = false
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '校对后正文'))
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()
    expect(wrapper.text()).toContain('已删除第 1 页')
    expect(rows(wrapper)[0]!.text()).toContain('未识别')
    expect(wrapper.text()).toContain('手工录入')
    expect(
      (document.activeElement as HTMLElement | null)?.closest(
        '[aria-label="翻页与页操作"]',
      ),
    ).not.toBeNull()
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
    await button(wrapper, '取消').trigger('click')
    await flushPromises()
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
    expect(wrapper.text()).toContain('共 3 页')
    expect(wrapper.text()).not.toContain('读不到这份文件的结果')
    expect(
      wrapper.get('button[aria-label="编辑"]').attributes('disabled'),
    ).toBeUndefined()
  })
})
