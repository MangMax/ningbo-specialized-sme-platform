// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ImagePreview from '../components/preview/ImagePreview.vue'
import { retrySrc } from '../lib/preview'

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
