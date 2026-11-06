/**
 * 宽表的**横向溢出提示**(票 16 UI 收口)。
 *
 * 表格在窄屏下保持宽表 + **容器内横向滚动**(与台账一致,不另造移动卡片列表),
 * 但滚动条本身在触屏/窄屏上常常看不见,所以要给一个**看得见的边缘提示**:
 * 首屏右侧渐隐 + 一行提示,滑到最右后两者都消失。
 */

export interface ScrollEdges {
  /** 左边还有内容(已经往右滚过)。 */
  left: boolean
  /** 右边还有内容(还没滑到最右)—— 提示就挂在这个状态上。 */
  right: boolean
}

export interface ScrollMetrics {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/**
 * 滚动条占位(像素)。
 *
 * 渐隐必须**停在内容边缘**而不是压在滚动条上 —— 压在滚动条上会在 thumb 上叠出一条
 * 比内容更深的色带(暗色下尤其明显),评审就是这个意见。滚动条宽度随平台/主题
 * (覆盖式 or 经典)不同,所以**量**出来,不写死。
 */
export interface ScrollBars {
  vertical: number
  horizontal: number
}

export function scrollBars(element: {
  offsetWidth: number
  clientWidth: number
  offsetHeight: number
  clientHeight: number
}): ScrollBars {
  return {
    vertical: Math.max(0, element.offsetWidth - element.clientWidth),
    horizontal: Math.max(0, element.offsetHeight - element.clientHeight),
  }
}

/** 亚像素抖动(safari/触控板)不能当成「还能滚」,所以留 1px 容差。 */
export const SCROLL_EPSILON = 1

/**
 * 由滚动量算两侧边缘状态。
 * 不溢出(内容比容器窄)时两侧都是 `false` —— 桌面宽屏不该出现任何提示。
 */
export function scrollEdges(metrics: ScrollMetrics, epsilon = SCROLL_EPSILON): ScrollEdges {
  const { scrollLeft, clientWidth, scrollWidth } = metrics
  const max = scrollWidth - clientWidth
  if (!Number.isFinite(max) || max <= epsilon) return { left: false, right: false }
  return {
    left: scrollLeft > epsilon,
    right: scrollLeft < max - epsilon,
  }
}
