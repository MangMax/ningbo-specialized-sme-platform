// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
 * 环境是 happy-dom,`$fetch` 由用例自己实现 —— 请求的**完成次序**因此完全可控,
 * 这正是复现竞态需要的能力(真浏览器里靠网速碰运气)。
 */

const FILE_A = { id: 1, relPath: 'jxj/announcement/2024/1/A-慢.pdf', filename: 'A-慢.pdf', ext: 'pdf', parseState: 'unparsed' }
const FILE_B = { id: 2, relPath: 'jxj/announcement/2024/2/B-快.pdf', filename: 'B-快.pdf', ext: 'pdf', parseState: 'unparsed' }

/** 一个可以由用例决定何时完成、完成什么的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn
  })
  return { promise, resolve }
}

/** 一份「页图现状」:页数 1、没渲染过 —— 行的页码由 `pageCount` 铺出来。 */
function pagesState(file: string) {
  return { file, pageCount: 1, dpi: 200, rendered: 0, upToDate: false, pages: [], manifest: null }
}

/** 一份「OCR 结果清单」。`markdown` 省略即模拟「正文那一半没读回来」。 */
function ocrList(file: string, text: string | undefined) {
  return {
    file: { id: 1, relPath: file, filename: file, ext: 'pdf', parseState: 'unparsed' },
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
  wrapper: ReturnType<typeof mount>
}

/** 挂起页面;`pdf` / `ocr` 两张表让用例决定每个文件的回包**何时**完成。 */
async function mountPage(): Promise<Harness> {
  const pdf = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const ocr = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const fetchMock = vi.fn((url: string, opts?: { query?: Record<string, unknown> }) => {
    if (url === '/api/files') return Promise.resolve({ rows: [FILE_A, FILE_B], total: 2 })
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
  })
  vi.stubGlobal('$fetch', fetchMock)

  const wrapper = mount(OcrPage, {
    global: {
      // `PageHeader` 是 Nuxt 自动导入的,裸 vitest 里没有 —— 给一个带 actions 槽的替身。
      components: { PageHeader: { template: '<header><slot name="actions" /></header>' } },
    },
  })
  await flushPromises()
  return { fetchMock, pdf, ocr, wrapper }
}

/** 左栏里点某一份文件。 */
async function selectFile(wrapper: Harness['wrapper'], label: string) {
  const button = wrapper.findAll('li button').find((b) => b.text().includes(label))
  expect(button, `左栏应有「${label}」`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

/** 当前渲染出来的逐页行。 */
function rows(wrapper: Harness['wrapper']) {
  return wrapper.findAll('ul[role="list"] > li')
}

let harness: Harness | null = null

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  harness?.wrapper.unmount()
  harness = null
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
    await row.findAll('button').find((b) => b.text().includes('编辑'))!.trigger('click')
    await flushPromises()
    await row.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')
    await flushPromises()

    const fileButtons = wrapper.findAll('li button').filter((b) => b.text().includes('.pdf'))
    expect(fileButtons.length).toBeGreaterThan(0)
    for (const button of fileButtons) expect(button.attributes('disabled')).toBeDefined()
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
    expect(wrapper.text()).not.toContain('空结果')
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
