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
 * 「识别校对」页的**读回 / 写回竞态**与**正文读取失败**两条回归(独立代码审核 B1 / B2)。
 *
 * 这两条都是**静默**数据损坏,纯函数测不到 —— 它们只发生在「谁的回包先落地」与
 * 「正文那一半拿不到时界面怎么显示」这两件事上,所以必须在页面这一层钉住:
 *
 *  - **B1**:`loadDetail` / `reloadResults` 原先在 `await` 之后**无条件**赋值。先点 A
 *    (慢),再点 B(快),A 的回包晚到就会把 A 的页图与正文灌进 B 的页面 ——
 *    文件名写着 B、内容是 A,这时点保存就是把 **A 的正文写进 B**。所以这里断言的是
 *    「**显示的是 B 的正文**」,不是「有没有报错」。
 *  - **B2**:正文原先靠「整份导出 → 按页标记反切」,失败被 `catch {}` 吞掉、再用 `?? ''`
 *    兜底 ⇒ **全部页显示「空结果」**,点编辑得到空框,保存即抹掉真实文本。现在正文
 *    逐页直接读;拿不到就**一页都不给**(没有行就没有编辑框)。这里断言的是
 *    「正文缺失时**没有可编辑的行**」。
 *
 * 环境是 jsdom,`$fetch` 由用例自己实现 —— 请求的**完成次序**因此完全可控,
 * 这正是复现竞态需要的能力(真浏览器里靠网速碰运气)。
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

/** 一个可以由用例决定何时完成、完成什么的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

/** 一份「页图现状」:没渲染过 —— 行的页码由 `pageCount` 铺出来(行数因此能当「显示的是谁」的判据)。 */
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

/** 一次渲染的产出(`RenderOutcome` = 页图现状 + 本次写入统计)。 */
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

/** 一份「OCR 结果清单」。`markdown` 省略即模拟「正文那一半没读回来」。 */
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
        chars: (text ?? '').length,
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
  /** 按 `file` 查询取得该文件的「页图现状」回包控制器。 */
  pdf: Map<string, ReturnType<typeof deferred<unknown>>>
  /** 按 `file` 查询取得该文件的「结果清单」回包控制器。 */
  ocr: Map<string, ReturnType<typeof deferred<unknown>>>
  /** 按 `file` 取得该文件**渲染**回包(`POST /api/pdf-pages`)的控制器。 */
  render: Map<string, ReturnType<typeof deferred<unknown>>>
  wrapper: ReturnType<typeof mount>
  router: ReturnType<typeof createRouter>
}

/** 挂起页面;`pdf` / `ocr` 两张表让用例决定每个文件的回包**何时**完成。 */
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
      // 渲染走 POST,页图现状走 GET —— 分开挂起,才能构造「渲染在飞时切文件」。
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
      // `PageHeader` 是 Nuxt 自动导入的,裸 vitest 里没有 —— 给一个带 actions 槽的替身。
      components: {
        PageHeader: { template: '<header><slot name="actions" /></header>' },
      },
    },
  })
  await flushPromises()
  return { fetchMock, pdf, ocr, render, wrapper, router }
}

/** 左栏里点某一份文件。 */
async function selectFile(wrapper: Harness['wrapper'], label: string) {
  const button = wrapper
    .findAll('li button')
    .find((b) => b.text().includes(label))
  expect(button, `左栏应有「${label}」`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

/** 当前渲染出来的逐页行。 */
function rows(wrapper: Harness['wrapper']) {
  return wrapper.findAll('ul[role="list"] li')
}

let harness: Harness | null = null

beforeEach(() => {
  vi.useRealTimers()
  vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: false, onchange: null, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return true },
  }))
})

afterEach(() => {
  harness?.wrapper.unmount()
  harness = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/**
 * B1:先点 A(慢)再点 B(快),然后让 **A 的回包晚到** —— 页面必须仍显示 B 的正文。
 *
 * 这条用例**不是**在测「有没有抛错」:旧实现在这条路径上一点错都不报,
 * 它只是安静地把 A 的内容放进 B 的页面,而这一点从画面上就能看出来。
 */
describe('B1 竞态:晚到的回包不许灌进新选的页面', () => {
  it('★ A 的页图与正文晚于 B 落地时,显示的仍是 B', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    await selectFile(wrapper, 'B-快')

    // B 先回来
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 的第一页正文'))
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath))
    await flushPromises()
    expect(wrapper.text()).toContain('B 的第一页正文')

    // A 晚到 —— 旧实现就是在这里把 B 的页面换成 A 的
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    expect(wrapper.text()).toContain('B 的第一页正文')
    expect(wrapper.text()).not.toContain('A 的第一页正文')
    // 文件条上的名字与内容必须是同一份 —— 这一条正是「写错文件」的前置条件。
    expect(wrapper.text()).toContain('B-快.pdf')
  })

  it('★ 写在飞期间**冻结文件切换**(写目标与显示内容必须同属一份文件)', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    // 进编辑 → 保存(POST 挂着不回,这一行一直处于「在飞」)
    const row = rows(wrapper)[0]!
    await row
      .findAll('button')
      .find((b) => b.text().includes('编辑'))!
      .trigger('click')
    await flushPromises()
    await row
      .findAll('button')
      .find((b) => b.text().includes('保存'))!
      .trigger('click')
    await flushPromises()

    const fileButtons = wrapper
      .findAll('li button')
      .filter((b) => b.text().includes('.pdf'))
    expect(fileButtons.length).toBeGreaterThan(0)
    for (const button of fileButtons)
      expect(button.attributes('disabled')).toBeDefined()
  })
})

/**
 * R1(B1 同类,只影响**显示**):`renderPageImages` 也是「发起时取一次路径、await 后无条件赋值」。
 *
 * 渲染一份 50 页的扫描件要好几秒,期间切到另一份文件完全正常;A 的回包晚到时,
 * `pagesState` 被换成 A 的 ⇒ 右栏在 **B 的文件名下列出 A 的页数与 A 的页图**,
 * 「图对着文本看」这个前提当场作废。这里让两份文件的**页数不同**,行数就是
 * 「显示的是谁」的判据:晚到后仍必须是 B 的 3 行,而不是 A 的 1 行。
 */
describe('R1 渲染回包:晚到也不许换掉页图', () => {
  it('★ 渲染 A 期间切到 B,A 的渲染结果晚到后页面仍是 B', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr, render } = harness

    await selectFile(wrapper, 'A-慢')
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 1))
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, 'A 的第一页正文'))
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)

    // 点「渲染页图」:POST 挂着不回(模拟几秒的渲染)
    const renderButton = wrapper
      .findAll('button')
      .find((b) => b.text().includes('渲染页图'))
    expect(renderButton, '未渲染时应给出「渲染页图」').toBeTruthy()
    await renderButton!.trigger('click')
    await flushPromises()

    // 渲染在飞时切到 B —— 不冻结切换(一次渲染几秒,锁住切换比丢回包更糟)
    await selectFile(wrapper, 'B-快')
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 3))
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 的第一页正文'))
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)

    // A 的渲染回包晚到
    render.get(FILE_A.relPath)!.resolve(renderOutcome(FILE_A.relPath, 1))
    await flushPromises()

    // 旧实现:pagesState 被换成 A 的(pageCount 1)⇒ 只剩 1 行
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.text()).toContain('B 的第一页正文')
    expect(wrapper.text()).toContain('全文件 3 页')
    expect(wrapper.text()).not.toContain('A 的第一页正文')
  })
})

/**
 * B2:正文那一半拿不到时,**一页都不给**。
 *
 * 旧的读法会把「反切失败」变成「每一页都是空结果」,再让编辑框预填空串 ——
 * 于是「读不到」直接通向「保存一次就抹掉」。这条用例钉住的是**没有行**这件事本身。
 */
describe('B2 正文读不回来时不许充当空结果', () => {
  it('★ 清单里没有逐页正文 ⇒ 显示读不到、且没有任何可编辑的行', async () => {
    harness = await mountPage()
    const { wrapper, pdf, ocr } = harness

    await selectFile(wrapper, 'A-慢')
    // 清单回来了,但每页都没有 `markdown`(正文那一半不可信)
    ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, undefined))
    pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath))
    await flushPromises()

    expect(wrapper.text()).toContain('读不到这份文件的结果')
    expect(wrapper.text()).toContain('逐页正文没读回来')
    // 没有行 ⇒ 没有「编辑 / 手工录入」入口 ⇒ 不可能对着空框保存
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('手工录入')
    expect(rows(wrapper)).toHaveLength(0)
  })

  it('正文读回来了才给行(对照组:同一份数据带上 markdown 就正常)', async () => {
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
    const { wrapper, pdf, ocr } = harness
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
    expect(wrapper.text()).toContain('全文件 97 页')
    await wrapper.get('input[aria-label="实际页号或范围"]').setValue('3-8')
    await wrapper
      .get('input[aria-label="当前文件正文关键词"]')
      .setValue('乙公司')
    await flushPromises()
    expect(wrapper.text()).toContain('命中 1 页')
    expect(rows(wrapper)[0]!.text()).toContain('第 8 页')
    expect(rows(wrapper)[0]!.text()).toContain('宁波乙公司')
    expect(wrapper.get('[aria-label="当前文件与页号"]').text()).toContain(
      '第 8 页 / 97 页',
    )
    expect(wrapper.text()).toContain('定位到首个命中：第 8 页')
    expect(
      harness.fetchMock.mock.calls.filter(
        ([, opts]) => opts?.method === 'POST',
      ),
    ).toHaveLength(0)
  })
})

async function loadA(pageCount = 4, markdown = '甲公司') {
  harness = await mountPage()
  await selectFile(harness.wrapper, 'A-慢')
  const response = ocrList(FILE_A.relPath, markdown)
  response.pages.push({ ...response.pages[0]!, page: 2, markdown: '' })
  response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
  response.count = 3
  harness.ocr.get(FILE_A.relPath)!.resolve(response)
  harness.pdf
    .get(FILE_A.relPath)!
    .resolve(pagesState(FILE_A.relPath, pageCount))
  await flushPromises()
  return harness
}
function button(wrapper: Harness['wrapper'], text: string) {
  return wrapper.findAll('button').find((b) => b.text().trim() === text)!
}

it('状态取并集，跨条件交集，保留命中当前页，空结果可恢复，非法页号不跳转', async () => {
  const { wrapper, fetchMock } = await loadA()
  await wrapper.get('#ocr-state-text').trigger('click')
  await wrapper.get('#ocr-state-empty').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('命中 3 页')
  expect(wrapper.text()).toContain('当前第 1 页')
  await wrapper.get('[aria-label="实际页号或范围"]').setValue('2-4')
  await flushPromises()
  expect(wrapper.text()).toContain('命中 2 页')
  expect(rows(wrapper)[0]!.text()).toContain('第 2 页')
  expect(rows(wrapper)[0]!.text()).toContain('空结果')
  await button(wrapper, '下一处').trigger('click')
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('乙公司')
  await wrapper.get('[aria-label="当前文件正文关键词"]').setValue('乙')
  await flushPromises()
  expect(wrapper.text()).toContain('当前第 4 页')
  await wrapper.get('[aria-label="跳转实际页号"]').setValue('3')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.text()).toContain('请输入当前命中范围内的实际页号')
  expect(wrapper.text()).toContain('当前第 4 页')
  await wrapper.get('[aria-label="实际页号或范围"]').setValue('8-2')
  await flushPromises()
  expect(wrapper.text()).toContain('页范围无效')
  expect(wrapper.text()).toContain('没有命中页')
  expect(rows(wrapper)).toHaveLength(0)
  await button(wrapper, '清除页筛选').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('命中 4 页')
  expect(rows(wrapper)[0]!.text()).toContain('第 1 页')
  expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method)).toHaveLength(
    0,
  )
})

it('URL 恢复文件、实际页和筛选，前后导航与返回保留上下文和其他查询', async () => {
  harness = await mountPage(
    `/ocr?file=${encodeURIComponent(FILE_A.relPath)}&page=4&states=text&range=1-8&text=公司&returnTo=%2Ffiles`,
  )
  const { wrapper, pdf, ocr, router } = harness
  const response = ocrList(FILE_A.relPath, '甲公司')
  response.pages.push({ ...response.pages[0]!, page: 4, markdown: '乙公司' })
  response.count = 2
  pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 8))
  ocr.get(FILE_A.relPath)!.resolve(response)
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('第 4 页')
  expect(
    wrapper.get('[aria-label="当前文件正文关键词"]').element,
  ).toHaveProperty('value', '公司')
  await button(wrapper, '上一处').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query.page).toBe('1')
  router.back()
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('第 4 页')
  expect(router.currentRoute.value.query.returnTo).toBe('/files')
})

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
  await router.push({
    path: '/ocr',
    query: { file: FILE_B.relPath, page: '1' },
  })
  await flushPromises()
  expect(router.currentRoute.value.query.file).toBe(FILE_A.relPath)
  const before = fetchMock.mock.calls.length
  await button(wrapper, '刷新').trigger('click')
  expect(fetchMock.mock.calls).toHaveLength(before)
  await button(wrapper, '取消').trigger('click')
  await flushPromises()
  await button(wrapper, '下一处').trigger('click')
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('第 2 页')
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
  expect(wrapper.text()).toContain('全文件 7 页')
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
  await button(wrapper, '保存').trigger('click')
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
  await wrapper.get('[aria-label="当前文件正文关键词"]').setValue('甲公司')
  await flushPromises()
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
  expect(rows(wrapper)[0]!.text()).toContain('第 1 页')
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
  await button(wrapper, '删除').trigger('click')
  expect(
    fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE'),
  ).toHaveLength(0)
  await button(wrapper, '取消').trigger('click')
  await button(wrapper, '删除').trigger('click')
  await button(wrapper, '确认删除').trigger('click')
  await flushPromises()
  expect(
    fetchMock.mock.calls.find(([, opts]) => opts?.method === 'DELETE')?.[1],
  ).toMatchObject({ query: { file: FILE_A.relPath, page: 1 } })
  ocr.get(FILE_A.relPath)!.resolve({ count: 0, pages: [] })
  await flushPromises()
  expect(wrapper.text()).toContain('已删除第 1 页')
  expect(rows(wrapper)[0]!.text()).toContain('未识别')
  expect(rows(wrapper)[0]!.text()).toContain('手工录入')
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
  await button(wrapper, '刷新').trigger('click')
  await flushPromises()
  pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('甲公司')
  expect(wrapper.text()).toContain('读不到这份文件的页图与识别结果。')
  expect(button(wrapper, '编辑').attributes('disabled')).toBeDefined()
  fail = false
  await button(wrapper, '重试').trigger('click')
  await flushPromises()
  ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '重试后的甲公司'))
  pdf.get(FILE_A.relPath)!.resolve(pagesState(FILE_A.relPath, 4))
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('重试后的甲公司')
  expect(button(wrapper, '编辑').attributes('disabled')).toBeUndefined()
})

it('文件名、来源、公布年组合过滤并清除，不另发每文件 OCR 请求且保留当前工作区', async () => {
  const { wrapper, router, fetchMock } = await loadA()
  await wrapper.get('[aria-label="按文件名搜索"]').setValue('A-慢')
  await flushPromises()
  expect(wrapper.text()).toContain('匹配 1 / 2 份 PDF')
  expect(
    wrapper.findAll('li button').filter((b) => b.text().includes('.pdf')),
  ).toHaveLength(1)
  await router.replace({
    query: { ...router.currentRoute.value.query, source: 'miit', year: '2023' },
  })
  await flushPromises()
  expect(wrapper.text()).toContain('匹配 0 / 2 份 PDF')
  expect(wrapper.text()).toContain('当前文件不在筛选结果中')
  expect(rows(wrapper)[0]!.text()).toContain('甲公司')
  await button(wrapper, '清除文件筛选').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('匹配 2 / 2 份 PDF')
  expect(
    fetchMock.mock.calls.filter(([url]) => url === '/api/ocr-results'),
  ).toHaveLength(1)
})

it('非法 URL 不选择未登记路径，状态与页号参数受校验', async () => {
  harness = await mountPage(
    '/ocr?file=../../other.pdf&page=-1&states=evil&source=evil&year=nope',
  )
  expect(harness.wrapper.text()).toContain('先选一份 PDF')
  expect(
    harness.fetchMock.mock.calls.filter(
      ([url]) => url === '/api/ocr-results' || url === '/api/pdf-pages',
    ),
  ).toHaveLength(0)
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
  await button(wrapper, '导入结果').trigger('click')
  await flushPromises()
  const body = new DOMWrapper(document.body)
  const markdownTab = body
    .findAll('[role="tab"]')
    .find((t) => t.text() === 'Markdown')!
  await markdownTab.trigger('mousedown', { button: 0 })
  await markdownTab.trigger('click')
  await flushPromises()
  const source = '<!-- page: 4 -->\n\n人工导入第四页'
  await body.get('#ocr-import-markdown').setValue(source)
  const submit =
    body
      .findAll('button')
      .find((b) => b.text().includes('导入') && b.text().includes('写入')) ??
    body.findAll('button').find((b) => b.text().trim() === '导入')!
  await submit.trigger('click')
  await flushPromises()
  expect(
    fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')?.[1],
  ).toMatchObject({
    body: { file: FILE_A.relPath, markdown: source, page: null },
  })
  const response = ocrList(FILE_A.relPath, '甲公司')
  response.pages.push({
    ...response.pages[0]!,
    page: 4,
    markdown: '人工导入第四页',
  })
  response.count = 2
  ocr.get(FILE_A.relPath)!.resolve(response)
  await flushPromises()
  expect(wrapper.text()).toContain('导入完成')
  expect(wrapper.text()).toContain('已写入 1 页(第 4 页)')
  expect(wrapper.text()).toContain('读回一致')
})

it('旧文件失败晚回包不将新文件的成功正文替换为错误', async () => {
  harness = await mountPage()
  const { wrapper, pdf, ocr } = harness
  await selectFile(wrapper, 'A-慢')
  const oldRead = ocr.get(FILE_A.relPath)!
  await selectFile(wrapper, 'B-快')
  pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath, 3))
  ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, 'B 已成功'))
  await flushPromises()
  oldRead.reject(new Error('A 失败'))
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('B 已成功')
  expect(wrapper.text()).toContain('全文件 3 页')
  expect(wrapper.text()).not.toContain('读不到这份文件的结果')
  expect(button(wrapper, '编辑').attributes('disabled')).toBeUndefined()
})

it('提交成功但读回缺少逐页正文时明确已提交并保留草稿', async () => {
  const { wrapper, fetchMock } = await loadA()
  const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
  fetchMock.mockImplementation((url, opts) => {
    if (url === '/api/ocr-results' && opts?.method === 'POST') return Promise.resolve({})
    if (url === '/api/ocr-results') return Promise.resolve(ocrList(FILE_A.relPath, undefined))
    return original(url, opts)
  })
  await button(wrapper, '编辑').trigger('click')
  await flushPromises()
  await wrapper.get('textarea').setValue('需要确认的人工修订')
  await button(wrapper, '保存').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('写入已提交,但读回失败')
  expect(wrapper.get('textarea').element).toHaveProperty('value', '需要确认的人工修订')
})

it('主区与同页对照使用可读名单表格和精确源码复制，显示操作不写入', async () => {
  const source = '# 原始名单\r\n\r\n<table><tr><td rowspan="2">宁波甲公司</td><td>2026</td></tr><tr><td>合并名单</td></tr></table>\r\n\r\n- 原始条目\r\n'
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  harness = await mountPage()
  const { wrapper, pdf, ocr, fetchMock } = harness
  await selectFile(wrapper, 'A-慢')
  const response = ocrList(FILE_A.relPath, source)
  ocr.get(FILE_A.relPath)!.resolve(response)
  pdf.get(FILE_A.relPath)!.resolve({ ...pagesState(FILE_A.relPath), pages: [{ page: 1, url: '/api/files/synthetic/page-1.png' }] })
  await flushPromises()
  expect(rows(wrapper)[0]!.get('h1').text()).toBe('原始名单')
  expect(rows(wrapper)[0]!.get('td[rowspan="2"]').text()).toBe('宁波甲公司')
  await button(wrapper, '查看源码').trigger('click')
  await flushPromises()
  expect(rows(wrapper)[0]!.get('pre').element.textContent!.replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'))
  await button(wrapper, '复制原文').trigger('click')
  expect(writeText).toHaveBeenLastCalledWith(source)
  await wrapper.get('[aria-label="放大看第 1 页"]').trigger('click')
  await flushPromises()
  const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
  expect(dialog.get('td[rowspan="2"]').text()).toBe('宁波甲公司')
  await dialog.findAll('button').find(b => b.text() === '查看源码')!.trigger('click')
  await flushPromises()
  expect(dialog.get('pre').element.textContent!.replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'))
  await dialog.findAll('button').find(b => b.text() === '复制原文')!.trigger('click')
  expect(writeText).toHaveBeenLastCalledWith(source)
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')).toEqual([])
  expect(response.pages[0]!.markdown).toBe(source)
})

it('渲染和源码后的编辑仍取原始 Markdown，取消与失败保留焦点和草稿且不自动保存', async () => {
  const source = '# 标题\n\n<table><tr><td onclick="alert(1)">企业甲</td></tr></table>\n'
  const { wrapper, fetchMock, ocr } = await loadA(4, source)
  await button(wrapper, '查看源码').trigger('click')
  await button(wrapper, '深色主题').trigger('click')
  expect(rows(wrapper)[0]!.get('[data-theme]').attributes('data-theme')).toBe('dark')
  await button(wrapper, '渲染预览').trigger('click')
  await button(wrapper, '编辑').trigger('click')
  await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('textarea').element))
  expect(wrapper.get('textarea').element).toHaveProperty('value', source)
  await wrapper.get('textarea').setValue('未提交草稿')
  await selectFile(wrapper, 'B-快')
  expect(wrapper.get('textarea').element).toHaveProperty('value', '未提交草稿')
  await button(wrapper, '取消').trigger('click')
  await vi.waitFor(() => expect(document.activeElement).toBe(button(wrapper, '编辑').element))
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([])
  await button(wrapper, '编辑').trigger('click')
  expect(wrapper.get('textarea').element).toHaveProperty('value', source)
  const original = fetchMock.getMockImplementation()! as (url: string, opts?: unknown) => Promise<unknown>
  let fail = true
  fetchMock.mockImplementation((url, opts) => {
    if (opts?.method === 'POST' && url === '/api/ocr-results')
      return fail ? Promise.reject(new Error('保存失败,请重试。')) : Promise.resolve({ written: 1, pages: [1] })
    return original(url, opts)
  })
  const edited = source + '\n校对  '
  await wrapper.get('textarea').setValue(edited)
  await button(wrapper, '保存').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('textarea').element))
  expect(wrapper.get('textarea').element).toHaveProperty('value', edited)
  expect(wrapper.text()).toContain('保存失败')
  fail = false
  await button(wrapper, '保存').trigger('click')
  await flushPromises()
  const writes = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(writes.map(([, options]) => options?.body)).toEqual([
    { file: FILE_A.relPath, page: 1, markdown: edited },
    { file: FILE_A.relPath, page: 1, markdown: edited },
  ])
  ocr.get(FILE_A.relPath)!.resolve(ocrList(FILE_A.relPath, '# 标题\n\n<table><tr><td onclick="alert(1)">企业甲</td></tr></table>\n\n校对'))
  await flushPromises()
  expect(wrapper.find('textarea').exists()).toBe(false)
  expect(rows(wrapper)[0]!.find('[onclick]').exists()).toBe(false)
  expect(rows(wrapper)[0]!.get('td').text()).toBe('企业甲')
})

it('空结果与未识别保持不同，97 页仅当前页提供预览和源码且复制失败不改变状态', async () => {
  const { wrapper, fetchMock } = await loadA(97, '# 第一页\n\n- 原始条目')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
  expect(wrapper.findAll('[aria-label="正文预览操作"]')).toHaveLength(1)
  await button(wrapper, '复制原文').trigger('click')
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('有文本')
  expect(wrapper.text()).toContain('复制失败')
  await wrapper.get('[aria-label="跳转实际页号"]').setValue('2')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('空结果')
  expect(rows(wrapper)[0]!.text()).toContain('正文为空')
  await button(wrapper, '查看源码').trigger('click')
  expect(rows(wrapper)[0]!.text()).toContain('空结果')
  await wrapper.get('[aria-label="跳转实际页号"]').setValue('97')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(rows(wrapper)[0]!.text()).toContain('未识别')
  expect(wrapper.find('[aria-label="正文预览操作"]').exists()).toBe(false)
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([])
})

it('OCR 主区跟随应用主题切换，换文件后不保留旧源码视图或复制提示', async () => {
  const ThemeToggle = (await import('../components/ThemeToggle.vue')).default
  const toggle = mount(ThemeToggle)
  try {
    const { wrapper, pdf, ocr } = await loadA()
    const themeBefore = rows(wrapper)[0]!.get('[data-theme]').attributes('data-theme')
    await toggle.get('button').trigger('click')
    await flushPromises()
    expect(rows(wrapper)[0]!.get('[data-theme]').attributes('data-theme')).toBe(themeBefore === 'dark' ? 'light' : 'dark')
    await button(wrapper, '查看源码').trigger('click')
    await selectFile(wrapper, 'B-快')
    ocr.get(FILE_B.relPath)!.resolve(ocrList(FILE_B.relPath, '# B 的新正文'))
    pdf.get(FILE_B.relPath)!.resolve(pagesState(FILE_B.relPath))
    await flushPromises()
    expect(rows(wrapper)[0]!.get('h1').text()).toBe('B 的新正文')
    expect(button(wrapper, '查看源码')).toBeTruthy()
    expect(wrapper.text()).not.toContain('甲公司')
  } finally {
    // Return the shared app color mode to its previous value for later cases.
    await toggle.get('button').trigger('click')
    toggle.unmount()
  }
})
