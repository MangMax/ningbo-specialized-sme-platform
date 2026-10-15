// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ImagePreview from '../components/preview/ImagePreview.vue'
import PageImageGallery from '../components/preview/PageImageGallery.vue'
import PreviewToolbar from '../components/preview/PreviewToolbar.vue'
import { PAGE_IMAGE_ZOOM_MIN } from '../lib/page-gallery'
import { fitZoom, nextZoom, retrySrc, ZOOM_ABS_MAX } from '../lib/preview'

/**
 * 图片预览的**失败 → 重试**恢复路径(票 13 回归)。
 *
 * 缺陷(独立审查发现,真实可达):加载失败后 `PreviewStates` 的重试**只把状态拨回
 * `loading`** —— `src` 与元素都没动,Vue 因此**没有触发任何新的加载**(不是「浏览器
 * 拒绝为同一地址重发」:独立实验里真的重新赋值同一个 `src` 或重建元素,Chrome 都会照发)。
 * 结果就是 `<img>` 停在失败态、界面永久卡在「正在读取文件…」。页图文件被删 / 404 是
 * 可达来源(服务端仍会把它列进清单),所以这是预览恢复路径上的真缺陷。
 *
 * 这些用例**不看「状态是不是 loading」**(旧实现也能装成那样),而是盯**可观察的加载尝试**:
 * 重试后 `<img>` 换成了新节点、地址也换了一个 —— 那才是浏览器会重新请求的证据。
 * 覆盖:重试后加载成功、重试后再次失败(还能再重试)。
 *
 * 环境是 `happy-dom`(不真的取图),所以加载结果由用例**手工派发** `load` / `error`
 * —— 与浏览器里那两个事件是同一对入口,组件无法分辨。
 */

const SRC = '/api/files/jxj/announcement/2022/.%E5%85%AC%E5%B8%83.pdf.pages/p003.png?v=2026-10-14'

/** 挂一份预览器并等到初始加载态。 */
function mountPreview(src: string = SRC) {
  return mount(ImagePreview, { props: { src, name: '第 3 页' } })
}

/** 当前的 `<img>`(元素与地址),用来判断「有没有换一次加载尝试」。 */
function currentImg(wrapper: ReturnType<typeof mountPreview>) {
  const img = wrapper.find('img')
  return { el: img.element, src: img.attributes('src') }
}

/** 「重试」按钮:错误态里 `PreviewStates` 给的那一颗。 */
function retryButton(wrapper: ReturnType<typeof mountPreview>) {
  return wrapper.findAll('button').find((b) => b.text().includes('重试'))
}

describe('retrySrc(纯规则:重试必须换一个地址)', () => {
  it('没重试过时**原样返回** —— 首次加载的地址一个字节都不变', () => {
    expect(retrySrc(SRC, 0)).toBe(SRC)
    expect(retrySrc('/a.png', 0)).toBe('/a.png')
  })

  it('重试后地址**必须变**(否则浏览器不会重新请求)', () => {
    expect(retrySrc(SRC, 1)).not.toBe(SRC)
    expect(retrySrc('/a.png', 1)).not.toBe('/a.png')
  })

  it('本来就带查询串(页图带 `?v=`)时接着用 `&`,不拼出两个 `?`', () => {
    const once = retrySrc(SRC, 1)
    expect(once.startsWith(SRC)).toBe(true)
    expect(once.match(/\?/g)).toHaveLength(1)
    expect(once).toContain('&retry=1')
  })

  it('带 fragment 时查询串插在 `#` **之前**(否则整段不进请求行,等于没带)', () => {
    expect(retrySrc('/a.png#page=2', 1)).toBe('/a.png?retry=1#page=2')
  })

  it('已有查询串 + fragment:先接 `&`,再原样带住 fragment', () => {
    expect(retrySrc('/a.png?v=9#page=2', 1)).toBe('/a.png?v=9&retry=1#page=2')
    expect(retrySrc('https://example.test/a.png?v=9#page=2', 2)).toBe(
      'https://example.test/a.png?v=9&retry=2#page=2',
    )
  })

  it('fragment 原样保留(不改写、不吞掉)', () => {
    expect(retrySrc('/a.png#page=2&zoom=1.5', 1)).toBe('/a.png?retry=1#page=2&zoom=1.5')
    // 只重试一次时,`#` 也只出现一次 —— 没把 fragment 复制成两段。
    expect(retrySrc('/a.png#page=2', 1).match(/#/g)).toHaveLength(1)
  })

  it('不带的地址用 `?`', () => {
    expect(retrySrc('/a.png', 1)).toBe('/a.png?retry=1')
  })

  it('每次重试的地址都不同 —— 连续重试次次都是一次新请求', () => {
    expect(retrySrc('/a.png', 1)).not.toBe(retrySrc('/a.png', 2))
  })

  it('**普通 URL(无 fragment)的结果与修复前逐字一致** —— 本次只动 fragment 情形', () => {
    // 字面量写死「父提交 63711c6 会得到什么」,让「没有改变普通 URL 行为」这句话可复核,
    // 而不是靠读实现自证。带 `#` 的输入不在这一条里(它正是本次要修的那类)。
    expect(retrySrc('/a.png', 1)).toBe('/a.png?retry=1')
    expect(retrySrc('/a.png', 2)).toBe('/a.png?retry=2')
    expect(retrySrc('https://example.test/a.png?x=1&y=2', 1)).toBe(
      'https://example.test/a.png?x=1&y=2&retry=1',
    )
    expect(retrySrc(SRC, 1)).toBe(`${SRC}&retry=1`)
    expect(retrySrc('/a.png', 0)).toBe('/a.png')
    expect(retrySrc('blob:http://localhost:3000/x', 1)).toBe('blob:http://localhost:3000/x')
    expect(retrySrc('relative/path.png', 1)).toBe('relative/path.png')
  })

  it('`blob:` / `data:` **不加参数**(加了就取不到东西),交给重建元素兜底', () => {
    const blob = 'blob:http://localhost:3000/1e49a114'
    const data = 'data:image/png;base64,AAAA'
    expect(retrySrc(blob, 1)).toBe(blob)
    expect(retrySrc(data, 1)).toBe(data)
  })
})

describe('ImagePreview 的失败 → 重试恢复', () => {
  it('首次加载:地址就是传进来的 src(既有行为不变)', () => {
    const wrapper = mountPreview()
    expect(currentImg(wrapper).src).toBe(SRC)
  })

  it('加载失败 → 出错误态与可点的「重试」', async () => {
    const wrapper = mountPreview()
    await wrapper.find('img').trigger('error')
    expect(retryButton(wrapper)).toBeTruthy()
  })

  it('**重试会真的发起一次新的加载尝试**(换节点 + 换地址),不是只把状态改回去', async () => {
    const wrapper = mountPreview()
    const before = currentImg(wrapper)
    await wrapper.find('img').trigger('error')

    await retryButton(wrapper)!.trigger('click')

    const after = currentImg(wrapper)
    // 旧实现:这两个断言都会挂 —— 元素还是那一个、地址还是那一个,
    // 浏览器因此不会重新请求,界面卡在「正在读取文件…」。
    expect(after.el).not.toBe(before.el)
    expect(after.src).not.toBe(before.src)
    expect(after.src).toContain('retry=1')
    // 并且回到了加载中(错误块消失)。
    expect(retryButton(wrapper)).toBeFalsy()
  })

  it('重试后**加载成功** → 从加载中回到图像', async () => {
    const wrapper = mountPreview()
    await wrapper.find('img').trigger('error')
    await retryButton(wrapper)!.trigger('click')

    await wrapper.find('img').trigger('load')

    expect(wrapper.find('img').classes()).toContain('preview-ready')
    expect(retryButton(wrapper)).toBeFalsy()
  })

  it('重试后**再次失败** → 仍能正常显示可重试的错误态,还能再重试一次', async () => {
    const wrapper = mountPreview()
    await wrapper.find('img').trigger('error')
    await retryButton(wrapper)!.trigger('click')

    const second = currentImg(wrapper)
    await wrapper.find('img').trigger('error')
    expect(retryButton(wrapper)).toBeTruthy()

    await retryButton(wrapper)!.trigger('click')
    const third = currentImg(wrapper)
    expect(third.el).not.toBe(second.el)
    expect(third.src).toContain('retry=2')
  })

  it('错误态为图片层挂 pointer-events-none class contract', async () => {
    // 图片层是状态层的**后置兄弟**,两者都 `absolute inset-0`:后置的在命中上压在上面,
    // 于是「重试」看得见却点不动(elementFromPoint 命中图片层)。键盘不经过命中测试,
    // 所以这个洞**只坏鼠标** —— 真实鼠标复验见票 13 的实现记录。
    const wrapper = mountPreview()
    const layer = () => wrapper.find('img').element.parentElement as HTMLElement

    // 还没显示出图片(加载中 / 已失败)时都不接指针事件。
    expect(layer().className).toContain('pointer-events-none')

    await wrapper.find('img').trigger('error')
    expect(layer().className).toContain('pointer-events-none')
    expect(retryButton(wrapper)).toBeTruthy()
  })

  it('ready 态移除图片层的 pointer-events-none class contract', async () => {
    const wrapper = mountPreview()
    const layer = () => wrapper.find('img').element.parentElement as HTMLElement

    await wrapper.find('img').trigger('error')
    expect(layer().className).toContain('pointer-events-none')

    await retryButton(wrapper)!.trigger('click')
    await wrapper.find('img').trigger('load')

    expect(layer().className).not.toContain('pointer-events-none')
  })

  it('换图(src 变化)会把重试计数清零 —— 新图从原地址开始', async () => {
    const wrapper = mountPreview()
    await wrapper.find('img').trigger('error')
    await retryButton(wrapper)!.trigger('click')
    expect(currentImg(wrapper).src).toContain('retry=1')

    await wrapper.setProps({ src: '/api/files/other.png' })
    expect(currentImg(wrapper).src).toBe('/api/files/other.png')
  })
})

/**
 * 缩放下限的**作用域隔离**(独立审查 P3)。
 *
 * `ZOOM_MIN` 原来是模块级常数,被改成 10% 后**全站**都跟着降 —— 而它同时服务
 * 「普通图片预览」与台账的「出处预览」,那两处从来不需要低于 25%,等于用一处改动
 * 悄悄改了别的页面。现在下限按调用方传(`zoomMin`,默认 25%),页图库显式传 10%。
 *
 * 这组用例锁两条路径,并且**同时看工具栏** —— 只改图片的钳制、让工具栏的按钮边界停在
 * 25%,会出现「图片已经缩到 19%,缩小键却是灰的」这种自相矛盾。
 */
describe('缩放下限:普通预览 25% / 页图库 10%(作用域隔离)', () => {
  /** 挂一份已加载完成的预览器(工具栏的缩放控件只在 ready 时渲染)。 */
  async function readyPreview(props: Record<string, unknown> = {}) {
    const wrapper = mount(ImagePreview, { props: { src: SRC, name: '第 3 页', ...props } })
    await wrapper.find('img').trigger('load')
    return wrapper
  }

  /** 工具栏上的「缩小」按钮(禁用态就是下限到了)。 */
  const zoomOut = (wrapper: Awaited<ReturnType<typeof readyPreview>>) =>
    wrapper.findAll('button').find((b) => b.attributes('aria-label') === '缩小')

  it('普通预览(不传 zoomMin)维持 **25% 下限** —— 台账出处预览等页面行为不变', async () => {
    const wrapper = await readyPreview()
    // 直接往下钳:0.01 会被夹到下限,而不是真的缩到 1%。
    ;(wrapper.vm as unknown as { zoomBy: (f: number) => void }).zoomBy(0.01)
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as unknown as { zoom: number }).zoom).toBeCloseTo(0.25, 5)
    // 工具栏同步:已到下限,「缩小」灰掉。
    expect(zoomOut(wrapper)!.attributes('disabled')).toBeDefined()
  })

  it('页图库路径(zoomMin=0.1)可**低于 25%**,且工具栏边界跟着降到 10%', async () => {
    const wrapper = await readyPreview({ zoomMin: PAGE_IMAGE_ZOOM_MIN })
    ;(wrapper.vm as unknown as { zoomBy: (f: number) => void }).zoomBy(0.01)
    await wrapper.vm.$nextTick()
    expect((wrapper.vm as unknown as { zoom: number }).zoom).toBeCloseTo(PAGE_IMAGE_ZOOM_MIN, 5)

    // 19% 是 390px 弹窗里 A4「适应」要到的档:默认下限够不到,页图库够得到。
    ;(wrapper.vm as unknown as { zoomBy: (f: number) => void }).zoomBy(1.9)
    await wrapper.vm.$nextTick()
    const at19 = (wrapper.vm as unknown as { zoom: number }).zoom
    expect(at19).toBeCloseTo(0.19, 5)
    // 关键:此时「缩小」**还能按**(19% > 10%)——若工具栏没跟着传下限,这里会是灰的。
    expect(zoomOut(wrapper)!.attributes('disabled')).toBeUndefined()
  })

  it('页图库确实把 PAGE_IMAGE_ZOOM_MIN 传给了预览器(接线,不只是常数) ', async () => {
    // 组件的取图走全局 `$fetch`,测试环境没有 —— 给它一个最小桩,让单页视图能渲染出来。
    const state = {
      file: 'jxj/announcement/2022/公布.pdf',
      pageCount: 1,
      dpi: 200,
      rendered: 1,
      upToDate: true,
      manifest: { dpi: 200, renderedAt: '2026-10-15T00:00:00.000Z' },
      pages: [
        {
          page: 1,
          relPath: 'jxj/announcement/2022/.公布.pdf.pages/p001.png',
          url: '/api/files/jxj/announcement/2022/.%E5%85%AC%E5%B8%83.pdf.pages/p001.png',
          width: 1653,
          height: 2339,
          bytes: 100,
        },
      ],
    }
    vi.stubGlobal('$fetch', vi.fn(async () => state))
    try {
      const gallery = mount(PageImageGallery, {
        props: { file: 'jxj/announcement/2022/公布.pdf' },
      })
      await new Promise((r) => setTimeout(r, 0)) // 等 load() 落地
      await gallery.vm.$nextTick()

      await gallery.find('button[title^="第 1 页"]').trigger('click')
      await gallery.vm.$nextTick()

      const preview = gallery.findComponent(ImagePreview)
      expect(preview.exists()).toBe(true)
      expect(preview.props('zoomMin')).toBe(PAGE_IMAGE_ZOOM_MIN)
      // 对照:同一组件不传时是 25%,说明这是**按调用方**分档,不是常数搬了家。
      expect(mount(ImagePreview, { props: { src: SRC } }).props('zoomMin')).toBe(0.25)

      // **接线**:图片预览的窄屏恢复路径靠它 opt-in(`resetToFitOnNarrow`)。
      // 组件默认是 `false` —— 所以这两条断言正好把「谁开了这条路径」钉住:
      // 图片预览 **开**,其余(含直接挂工具栏的 OfficePreview)**不开**。
      const inner = preview.findComponent(PreviewToolbar)
      expect(inner.props('resetToFitOnNarrow')).toBe(true)
      expect(mount(PreviewToolbar, { props: { title: 't' } }).props('resetToFitOnNarrow')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 自动「适应」与手动缩放下限的**分工**,以及窄屏自定义控件的边界(复核 F1 / F3)。
 *
 * F1(reviewer 在 2400×3200 + 390×844 上看到可见性回退):`fit()` 原来也按**手动**下限夹,
 * fit ≈ 13.5% 被夹到 25%,图反而**横纵溢出**;而窄屏下工具栏的缩放控件是隐藏的,用户没法缩回来。
 * 修法:自动 fit 只受绝对下限约束(`fitZoom`),手动缩放仍受 `props.zoomMin`(`nextZoom`)。
 * 另:从「低于手动下限的 fit 状态」往外缩时,**不能反而放大**(那是同一个 `max` 造成的错觉)。
 */
describe('fit 不受手动下限约束 / 手动缩放边界(nextZoom)', () => {
  it('`fitZoom`:超大图的适应比例可以**低于**手动下限 25%(2400×3200 → 390px 约 13.5%)', () => {
    // 与 reviewer 的合成输入同量级:viewport 356×713、图 2400×3200、pad 32。
    const scale = Math.min((356 - 32) / 2400, (713 - 32) / 3200)
    expect(scale).toBeCloseTo(0.135, 2) // ≈ 13.5%
    expect(scale).toBeLessThan(0.25) // 手动下限之下
    // 关键:fit 取的就是它 —— 不被 25% 拉高(拉高才会溢出)。
    expect(fitZoom(scale, ZOOM_ABS_MAX)).toBeCloseTo(scale, 6)
  })

  it('`fitZoom` 仍受**绝对**下限/上限约束(不产出 0 / 无穷)', () => {
    expect(fitZoom(0, ZOOM_ABS_MAX)).toBeGreaterThan(0)
    expect(fitZoom(99, ZOOM_ABS_MAX)).toBe(ZOOM_ABS_MAX)
  })

  it('**从低于手动下限的 fit 状态往外缩,不会反而放大**(F1 的错觉)', () => {
    const current = 0.135 // fit 落点(手动下限 0.25 之下)
    const minZoom = 0.25
    // 滚轮向外一次:0.135 / 1.12 ≈ 0.12。旧写法 max(0.25, 0.12) = 0.25 ⇒ **变大**了。
    const outward = nextZoom(current / 1.12, current, minZoom)
    expect(outward).toBeLessThanOrEqual(current)
    expect(outward).toBeCloseTo(current, 6) // 停在原地 = 不再缩小
    // 对照:旧的「无脑 max(下限, 请求)」确实会把它拉到 0.25(放大),证明该用例有区分力。
    expect(Math.max(minZoom, current / 1.12)).toBeCloseTo(0.25, 6)
  })

  it('手动缩放**在下限之上**照常夹到 25% —— 没有回归', () => {
    // 当前 0.3,往内(放大)不受影响。
    expect(nextZoom(0.3 * 1.12, 0.3, 0.25)).toBeCloseTo(0.336, 6)
    // 当前已在下限时,再往外只会停在 0.25,不会穿过去。
    expect(nextZoom(0.25 / 1.12, 0.25, 0.25)).toBeCloseTo(0.25, 6)
  })
})

/**
 * F3:窄屏那组**自定义**缩放控件(页图库单页头部,`sm:hidden`)要与工具栏同一判据。
 * 「缩小」原来没有 disabled,10% 时还亮着 —— 点了没反应(`nextZoom` 停在原地)。
 * 这里复用上面「接线」用例的合成 state 与 `$fetch` 桩(不读正式 files/data)。
 */
describe('窄屏自定义缩放的边界(F3)', () => {
  const file = 'jxj/announcement/2022/公布.pdf'
  const state = {
    file,
    pageCount: 1,
    dpi: 200,
    rendered: 1,
    upToDate: true,
    manifest: { dpi: 200, renderedAt: '2026-10-15T00:00:00.000Z' },
    pages: [
      {
        page: 1,
        relPath: 'jxj/announcement/2022/.公布.pdf.pages/p001.png',
        url: '/api/files/jxj/announcement/2022/.%E5%85%AC%E5%B8%83.pdf.pages/p001.png',
        width: 1653,
        height: 2339,
        bytes: 100,
      },
    ],
  }

  /** 挂出单页视图(窄屏那组控件的父视图)。 */
  async function openSinglePage() {
    vi.stubGlobal('$fetch', vi.fn(async () => state))
    const gallery = mount(PageImageGallery, { props: { file } })
    await new Promise((r) => setTimeout(r, 0))
    await gallery.vm.$nextTick()
    await gallery.find('button[title^="第 1 页"]').trigger('click')
    await gallery.vm.$nextTick()
    return gallery
  }

  /** 窄屏那组里的「缩小」(按 aria-label),它与宽屏工具栏那颗同名 —— 取**可见**的那颗。 */
  function narrowZoomOut(gallery: Awaited<ReturnType<typeof openSinglePage>>) {
    const btn = gallery
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '缩小' && !b.classes().includes('hidden'))
    return btn
  }

  it('窄屏缩放组到达 10% 后禁用缩小按钮', async () => {
    try {
      const gallery = await openSinglePage()
      const preview = gallery.findComponent(ImagePreview)
      const vm = preview.vm as unknown as { zoom: number; fit: () => void; zoomBy: (f: number) => void }

      // 先模拟「适应」落在下限(把 zoom 压到 10%)。
      vm.zoomBy(0.001)
      await gallery.vm.$nextTick()
      expect(vm.zoom).toBeCloseTo(PAGE_IMAGE_ZOOM_MIN, 5)
      expect(narrowZoomOut(gallery)!.attributes('disabled')).toBeDefined()

      // 放大一档 → 回到下限之上,「缩小」恢复可用。
      vm.zoomBy(1.5)
      await gallery.vm.$nextTick()
      expect(vm.zoom).toBeGreaterThan(PAGE_IMAGE_ZOOM_MIN)
      expect(narrowZoomOut(gallery)!.attributes('disabled')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * **组件级**:自动「适应」的 contain 与手动下限的分工(plan 的 req 1–3)。
 *
 * 与上面那组**纯规则**用例互补:这里真的挂组件、给合成的图尺寸与容器尺寸、走**真实路径**
 * (`onLoad` → `fit()`、`wheel` 事件),并断言**渲染出来的尺寸**装得下容器 —— 规则对不代表
 * 接线对。合成尺寸与 UI 复核同量级(2400×3200 图 / 356×713 容器),**不读正式 files/data**。
 */
describe('适应与手动下限:组件级(req 1–3)', () => {
  const NATURAL = { w: 2400, h: 3200 }
  const VIEWPORT = { w: 356, h: 713 } // reviewer 在 390×844 弹窗里观察到的图片视口
  const PAD = 32 // fitScale() 里留的边距

  /** 挂一份预览器并塞进合成尺寸,走 onLoad → fit()。返回组件与两个元素。 */
  async function fittedPreview(props: Record<string, unknown> = {}) {
    const wrapper = mount(ImagePreview, { props: { src: SRC, name: '第 3 页', ...props } })
    const img = wrapper.find('img').element as HTMLImageElement
    const viewport = img.parentElement!.parentElement as HTMLElement
    Object.defineProperty(img, 'naturalWidth', { value: NATURAL.w, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: NATURAL.h, configurable: true })
    Object.defineProperty(viewport, 'clientWidth', { value: VIEWPORT.w, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { value: VIEWPORT.h, configurable: true })
    await wrapper.find('img').trigger('load') // onLoad → fit()
    const vm = wrapper.vm as unknown as {
      zoom: number
      zoomBy: (f: number) => void
    }
    return { wrapper, img, viewport, vm }
  }

  it('fit below the manual zoom floor still contains the image', async () => {
    const { vm } = await fittedPreview()

    // 走的是**真实的 fit 路径**:落点 = contain 比例(≈13.5%),**低于**手动下限 25%。
    const expected = Math.min((VIEWPORT.w - PAD) / NATURAL.w, (VIEWPORT.h - PAD) / NATURAL.h)
    expect(vm.zoom).toBeCloseTo(expected, 6)
    expect(vm.zoom).toBeLessThan(0.25)

    // 关键断言:**渲染尺寸装得下容器**(contain)。旧的 clampZoom(0.25) 会得到 600×800 而溢出。
    expect(NATURAL.w * vm.zoom).toBeLessThanOrEqual(VIEWPORT.w)
    expect(NATURAL.h * vm.zoom).toBeLessThanOrEqual(VIEWPORT.h)
    // 对照:按 25% 夹的旧行为**确实会溢出**,证明这条用例有区分力。
    expect(NATURAL.w * Math.max(0.25, expected)).toBeGreaterThan(VIEWPORT.w)
  })

  it('below-fit 往返:点「放大」到 fit 之上,再点「缩小」**回到 fit** 并重新禁用', async () => {
    // 全程走**真实按钮**(predicate + handler 两侧契约),与浏览器实测同一条路径。
    const { wrapper, vm } = await fittedPreview()
    const fit = vm.zoom // ≈13.5%,落在手动下限 25% 之下
    expect(fit).toBeLessThan(0.25)

    const btn = (label: string) => wrapper.findAll('button').find((b) => b.attributes('aria-label') === label)
    await wrapper.vm.$nextTick()
    expect(btn('缩小')!.attributes('disabled')).toBeDefined() // fit 上:已禁用

    // 点「放大」若干次 → 越过 fit、且越过手动下限 25%。
    for (let i = 0; i < 8; i += 1) {
      await btn('放大')!.trigger('click')
    }
    await wrapper.vm.$nextTick()
    expect(vm.zoom).toBeGreaterThan(0.25)
    expect(btn('缩小')!.attributes('disabled')).toBeUndefined() // 放大后:可用

    // 点「缩小」一路下去 → 回到 **fit 本身**(有效下限 = min(手动下限, fit)),
    // 而不是停在 25%(旧实现执行时用 25% ⇒ 这里会卡在 0.25)。
    for (let i = 0; i < 16; i += 1) {
      await btn('缩小')!.trigger('click')
    }
    await wrapper.vm.$nextTick()
    expect(vm.zoom).toBeCloseTo(fit, 6)
    expect(vm.zoom).toBeLessThan(0.25) // 确实回到了手动下限之下

    // 回到 fit 后:再点一次不变,且按钮**重新禁用**(判据与执行同一个有效下限)。
    await btn('缩小')!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(vm.zoom).toBeCloseTo(fit, 6)
    expect(btn('缩小')!.attributes('disabled')).toBeDefined()
  })

  it('fit 与手动下限之间:「缩小」**可用**且点击**确实变小**(判据与执行同源)', async () => {
    // 这一段是最容易出错的区间:能到的最小是 fit(≈13.5%),但当前位置(如 23.5%)还在手动下限 25% 之下。
    // 若判据用 25% ⇒ 这里会被**误禁**(灰着却其实还能缩);若执行用 25% ⇒ 点了**没反应**。
    const { wrapper, vm } = await fittedPreview()
    const fit = vm.zoom
    expect(fit).toBeLessThan(0.25)

    vm.zoomBy(1.12) // 一步放大 → ≈15.1%,仍在 25% 之下
    await wrapper.vm.$nextTick()
    const mid = vm.zoom
    expect(mid).toBeGreaterThan(fit)
    expect(mid).toBeLessThan(0.25)

    const zoomOut = wrapper.findAll('button').find((b) => b.attributes('aria-label') === '缩小')
    expect(zoomOut!.attributes('disabled')).toBeUndefined() // 可用

    await zoomOut!.trigger('click') // 真的点那颗按钮
    await wrapper.vm.$nextTick()
    expect(vm.zoom).toBeLessThan(mid) // 确实变小了
  })

  it('zooming out from a below-floor fit does not increase the scale', async () => {
    const { wrapper, viewport, vm } = await fittedPreview()
    const before = vm.zoom
    expect(before).toBeLessThan(0.25)

    // **真实滚轮事件**:deltaY > 0 = 向外缩(旧实现在这里会被 max(0.25, 请求) **放大到 25%**)。
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()

    expect(vm.zoom).toBeLessThanOrEqual(before) // 绝不反向变大
    expect(vm.zoom).not.toBeCloseTo(0.25, 6) // 也没跳到下限
    // 往里(放大)照常生效,证明滚轮整体没坏。
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    expect(vm.zoom).toBeGreaterThan(before)
  })
})

/**
 * 取整只用于**文本**,不能用于**判据**(标准复核的 findings)。
 *
 * 症状(1280×800 对话框、2400×3200 原图):实际 fit scale 0.135 ⇒ 工具栏**显示 14%**,
 * 而「缩小」`disabled=false` —— 点下去仍是 14%。根因:禁用判据当时用**取整后**的 `zoomPercent`
 * (14)去比 `zoomMin × 100`(13.5),`14 <= 13.5` 为假。改用未取整的 `zoom` 比较。
 */
describe('工具栏:百分比取整只用于文本(判据用未取整 scale)', () => {
  /** 挂一份预览器,把 zoom 直接摆到 `scale`,并让 fit 与之一致。 */
  async function previewAt(scale: number) {
    const wrapper = mount(ImagePreview, { props: { src: SRC, name: '第 3 页' } })
    const img = wrapper.find('img').element as HTMLImageElement
    const viewport = img.parentElement!.parentElement as HTMLElement
    // 让 fitScale() 正好落在 `scale`:viewport = 图尺寸 × scale + pad。
    Object.defineProperty(img, 'naturalWidth', { value: 2400, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 3200, configurable: true })
    Object.defineProperty(viewport, 'clientWidth', { value: Math.round(2400 * scale) + 32, configurable: true })
    Object.defineProperty(viewport, 'clientHeight', { value: Math.round(3200 * scale) + 32, configurable: true })
    await wrapper.find('img').trigger('load') // onLoad → fit() → 落在 scale(且低于手动下限)
    const vm = wrapper.vm as unknown as { zoom: number }
    return { wrapper, vm, zoomOut: () => wrapper.findAll('button').find((b) => b.attributes('aria-label') === '缩小') }
  }

  it('13.5% 显示为 14%,但「缩小」**已禁用**(不取整比较)', async () => {
    const { vm, zoomOut } = await previewAt(0.135)

    // 实际缩放是 13.5%(低于手动下限 25% —— fit 允许),测试文本显示为整数 14%。
    expect(vm.zoom).toBeCloseTo(0.135, 3)
    expect(Math.round(vm.zoom * 100)).toBe(14)
    // 关键断言:已经在下限(此处下限 = 当前 fit 13.5%),按钮必须**禁用**。
    // 旧判据 `14 <= 13.5` 为假 ⇒ 会亮着却点不动,这条会红。
    expect(zoomOut()!.attributes('disabled')).toBeDefined()
  })

  it('fitScale ≥ 手动下限时:高于下限「缩小」可用,夹到 25% 后禁用 —— 边界不早不禁', async () => {
    const { wrapper, vm, zoomOut } = await previewAt(0.5)
    expect(vm.zoom).toBeCloseTo(0.5, 3)
    // 0.5 > 下限(0.25)→ 可用。
    expect(zoomOut()!.attributes('disabled')).toBeUndefined()

    // 一路缩小到 0.25(手动下限)后禁用。
    const vmAny = wrapper.vm as unknown as { zoomBy: (f: number) => void }
    for (let i = 0; i < 12; i += 1) vmAny.zoomBy(1 / 1.12)
    await wrapper.vm.$nextTick() // 读 DOM 属性前先让 Vue 把 :disabled 刷上去
    expect(vm.zoom).toBeCloseTo(0.25, 6)
    expect(zoomOut()!.attributes('disabled')).toBeDefined()
  })
})

/**
 * #1 页图库窄屏缩小的判据必须用**子预览的有效下限**(复核:fit=0.04789、配置下限 10% 时,
 * zoom=0.06728 的按钮仍 disabled,而 handler 实际能缩到 0.06007 —— 同一类失配)。
 */
describe('页图库窄屏缩小判据用有效下限(#1)', () => {
  const file = 'jxj/announcement/2022/公布.pdf'
  const state = {
    file,
    pageCount: 1,
    dpi: 200,
    rendered: 1,
    upToDate: true,
    manifest: { dpi: 200, renderedAt: '2026-10-15T00:00:00.000Z' },
    pages: [
      {
        page: 1,
        relPath: 'jxj/announcement/2022/.公布.pdf.pages/p001.png',
        url: '/api/files/jxj/announcement/2022/.%E5%85%AC%E5%B8%83.pdf.pages/p001.png',
        width: 1653,
        height: 2339,
        bytes: 100,
      },
    ],
  }

  /** 挂出单页视图,并把子预览的尺寸摆成 fit 落在配置下限(10%)之下。 */
  async function openWithFit(fitBelowConfigFloor: boolean) {
    vi.stubGlobal('$fetch', vi.fn(async () => state))
    const gallery = mount(PageImageGallery, { props: { file } })
    await new Promise((r) => setTimeout(r, 0))
    await gallery.vm.$nextTick()
    await gallery.find('button[title^="第 1 页"]').trigger('click')
    await gallery.vm.$nextTick()

    const preview = gallery.findComponent(ImagePreview)
    const img = preview.find('img').element as HTMLImageElement
    const vp = img.parentElement!.parentElement as HTMLElement
    // fit = (vp - 32) / natural。取 fit<10%(超大图)或 fit>10%(小图)。
    const naturalW = fitBelowConfigFloor ? 5580 : 1116 // 5580*0.1≈558;要 fit≈0.0479 取更大
    const naturalH = Math.round(naturalW * (3200 / 2400))
    Object.defineProperty(img, 'naturalWidth', { value: fitBelowConfigFloor ? 5580 : 1200, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: fitBelowConfigFloor ? 7440 : 1600, configurable: true })
    Object.defineProperty(vp, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(vp, 'clientHeight', { value: 600, configurable: true })
    void naturalW
    void naturalH
    await preview.find('img').trigger('load') // onLoad → fit()
    await gallery.vm.$nextTick()
    return { gallery, preview, vm: preview.vm as unknown as { zoom: number; zoomBy: (f: number) => void; effectiveZoomMin: number } }
  }

  const narrowZoomOut = (g: Awaited<ReturnType<typeof openWithFit>>) =>
    g.gallery
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '缩小' && !b.classes().includes('hidden'))

  it('fit < 配置下限(10%)时:缩小可用且点击**确实变小**,到 fit 才禁用', async () => {
    try {
      const g = await openWithFit(true)
      const fit = g.vm.zoom
      expect(fit).toBeLessThan(PAGE_IMAGE_ZOOM_MIN) // 落在配置下限之下
      expect(g.vm.effectiveZoomMin).toBeCloseTo(fit, 6)

      // fit 上:禁用。
      await g.gallery.vm.$nextTick()
      expect(narrowZoomOut(g)!.attributes('disabled')).toBeDefined()

      // 放大一档 → 仍在 10% 之下,但**高于 fit**:按钮应**可用**(旧判据按 10% 会误禁)。
      g.vm.zoomBy(1.12)
      await g.gallery.vm.$nextTick()
      const mid = g.vm.zoom
      expect(mid).toBeGreaterThan(fit)
      expect(mid).toBeLessThan(PAGE_IMAGE_ZOOM_MIN)
      expect(narrowZoomOut(g)!.attributes('disabled')).toBeUndefined()

      // 真点一下 → 确实变小(可达)。
      await narrowZoomOut(g)!.trigger('click')
      await g.gallery.vm.$nextTick()
      expect(g.vm.zoom).toBeLessThan(mid)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fit ≥ 配置下限(10%)时:照旧守 10% 地板', async () => {
    try {
      const g = await openWithFit(false)
      expect(g.vm.zoom).toBeGreaterThanOrEqual(PAGE_IMAGE_ZOOM_MIN)
      // 缩小到 10% → 禁用。
      for (let i = 0; i < 25; i += 1) g.vm.zoomBy(1 / 1.12)
      await g.gallery.vm.$nextTick()
      expect(g.vm.zoom).toBeCloseTo(PAGE_IMAGE_ZOOM_MIN, 6)
      expect(narrowZoomOut(g)!.attributes('disabled')).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * #2 窄屏恢复路径:百分比按钮在窄屏点一下回「适应」(而不是回 100%)。
 * 复核在 390×844 上量到:点百分比从 14% 跳到 100%(图宽 ~2400 CSS px,只剩局部),
 * 而窄屏没有 ± / 适宽,点图与滚轮也不生效 —— 只能全屏或关掉重开。
 */
describe('窄屏百分比按钮:opt-in 决定回「适应」还是回 100%', () => {
  /** 在指定断点下挂一份工具栏。`matchMedia` 是只读属性,这里用一次断言赋值做测试桩。 */
  function mountAt(narrow: boolean, props: Record<string, unknown> = {}) {
    const original = window.matchMedia
    ;(window as { matchMedia: typeof window.matchMedia }).matchMedia = ((q: string) =>
      ({
        matches: narrow && q === '(max-width: 639.98px)',
        media: q,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia
    const wrapper = mount(PreviewToolbar, { props: { title: 't', zoom: 0.14, zoomMin: 0.1, ...props } })
    return { wrapper, restore: () => ((window as { matchMedia: typeof window.matchMedia }).matchMedia = original) }
  }

  const pctBtn = (w: ReturnType<typeof mount>) => w.findAll('button').find((b) => b.text().includes('%'))!

  it('**未 opt-in**(如 OfficePreview)窄屏:仍发 update:zoom=1,可访问名包含可见百分比和动作', async () => {
    const { wrapper, restore } = mountAt(true)
    try {
      const pct = pctBtn(wrapper)
      // 关键:窄屏 + 未 opt-in ⇒ **不得**发 fit-width(Office 的 fit-width 是「适宽」,不是 100%)。
      expect(pct.text()).toBe('14%')
      expect(pct.attributes('aria-label')).toBe('14% · 恢复到 100%')
      expect(pct.attributes('title')).toBe('14% · 恢复到 100%')
      await pct.trigger('click')
      expect(wrapper.emitted('fit-width')).toBeFalsy()
      expect(wrapper.emitted('update:zoom')?.[0]).toEqual([1])
    } finally {
      restore()
    }
  })

  it('**opt-in**(图片预览)窄屏:发 fit-width,可访问名包含可见百分比和动作', async () => {
    const { wrapper, restore } = mountAt(true, { resetToFitOnNarrow: true })
    try {
      const pct = pctBtn(wrapper)
      expect(pct.text()).toBe('14%')
      expect(pct.attributes('aria-label')).toBe('14% · 适应页面(整页可见)')
      expect(pct.attributes('title')).toBe('14% · 适应页面(整页可见)')
      await pct.trigger('click')
      expect(wrapper.emitted('fit-width')).toBeTruthy()
      expect(wrapper.emitted('update:zoom')).toBeFalsy()
    } finally {
      restore()
    }
  })

  it('**opt-in 但宽屏**:仍回 100%(桌面交互不变)', async () => {
    const { wrapper, restore } = mountAt(false, { resetToFitOnNarrow: true })
    try {
      const pct = pctBtn(wrapper)
      expect(pct.attributes('aria-label')).toBe('14% · 恢复到 100%')
      await pct.trigger('click')
      expect(wrapper.emitted('fit-width')).toBeFalsy()
      expect(wrapper.emitted('update:zoom')?.[0]).toEqual([1])
    } finally {
      restore()
    }
  })

  it('**未 opt-in 且宽屏**:回 100%(两条默认路径都不受影响)', async () => {
    const { wrapper, restore } = mountAt(false)
    try {
      await pctBtn(wrapper).trigger('click')
      expect(wrapper.emitted('fit-width')).toBeFalsy()
      expect(wrapper.emitted('update:zoom')?.[0]).toEqual([1])
    } finally {
      restore()
    }
  })
})
