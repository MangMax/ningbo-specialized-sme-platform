import { describe, expect, it } from 'vitest'
import { SCROLL_EPSILON, scrollBars, scrollEdges } from '../../../lib/scroll-edges'

/**
 * 窄屏宽表的边缘提示判定(票 16 UI 收口 B2)。
 * 「右侧还有内容」= 提示与右渐隐的显示条件;滑到最右必须变 false。
 */
describe('scrollEdges', () => {
  const withOverflow = { clientWidth: 390, scrollWidth: 1020 }

  it('不溢出:两侧都 false(桌面宽屏不该出现提示)', () => {
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 1020, scrollWidth: 1020 })).toEqual({
      left: false,
      right: false,
    })
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 1200, scrollWidth: 1020 })).toEqual({
      left: false,
      right: false,
    })
  })

  it('首屏:只有右侧还有内容', () => {
    expect(scrollEdges({ ...withOverflow, scrollLeft: 0 })).toEqual({ left: false, right: true })
  })

  it('中间:两侧都有', () => {
    expect(scrollEdges({ ...withOverflow, scrollLeft: 300 })).toEqual({ left: true, right: true })
  })

  it('滑到最右:右侧提示消失(只剩左侧)', () => {
    expect(scrollEdges({ ...withOverflow, scrollLeft: 630 })).toEqual({ left: true, right: false })
  })

  it('亚像素抖动(≤1px)不算「还能滚」', () => {
    expect(scrollEdges({ ...withOverflow, scrollLeft: 629.4 })).toEqual({
      left: true,
      right: false,
    })
    expect(scrollEdges({ ...withOverflow, scrollLeft: 0.4 })).toEqual({
      left: false,
      right: true,
    })
    expect(SCROLL_EPSILON).toBe(1)
  })

  it('拿不到尺寸(NaN/未挂载)时两侧都 false,不误报', () => {
    expect(
      scrollEdges({ scrollLeft: 0, clientWidth: Number.NaN, scrollWidth: Number.NaN }),
    ).toEqual({ left: false, right: false })
  })
})

describe('scrollBars(渐隐要停在内容边缘,不能压在滚动条上)', () => {
  it('量出滚动条占位', () => {
    expect(
      scrollBars({ offsetWidth: 356, clientWidth: 348, offsetHeight: 380, clientHeight: 372 }),
    ).toEqual({ vertical: 8, horizontal: 8 })
  })

  it('覆盖式滚动条(占位 0)或拿不到尺寸时给 0,不产生负值', () => {
    expect(
      scrollBars({ offsetWidth: 346, clientWidth: 346, offsetHeight: 380, clientHeight: 380 }),
    ).toEqual({ vertical: 0, horizontal: 0 })
    expect(
      scrollBars({ offsetWidth: 300, clientWidth: 320, offsetHeight: 300, clientHeight: 320 }),
    ).toEqual({ vertical: 0, horizontal: 0 })
  })
})
