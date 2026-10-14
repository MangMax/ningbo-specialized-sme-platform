import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * 宽表的**横向溢出提示**(票 16 UI 收口)。
 *
 * 表格在窄屏下保持宽表 + **容器内横向滚动**(与台账一致,不另造移动卡片列表),
 * 但滚动条本身在触屏/窄屏上常常看不见,所以要给一个**看得见的边缘提示**:
 * 首屏右侧渐隐 + 一行提示,滑到最右后两者都消失。
 *
 * 判定是纯函数,便于单测;`useScrollEdges` 只负责把它接到 DOM 上。
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

/**
 * 把 {@link scrollEdges} 接到一个滚动容器上:监听滚动与尺寸变化
 * (窗口缩放、切 tab、行数变化都会改宽度),卸载时全部解绑。
 */
export function useScrollEdges(el: Ref<HTMLElement | null | undefined>) {
  const edges = ref<ScrollEdges>({ left: false, right: false })

  function measure() {
    const node = el.value
    if (!node) {
      edges.value = { left: false, right: false }
      return
    }
    edges.value = scrollEdges({
      scrollLeft: node.scrollLeft,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    })
  }

  let observer: ResizeObserver | null = null

  function attach() {
    const node = el.value
    if (!node) return
    node.addEventListener('scroll', measure, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(node)
    }
    measure()
  }

  function detach() {
    el.value?.removeEventListener('scroll', measure)
    observer?.disconnect()
    observer = null
  }

  onMounted(() => {
    attach()
    // 容器可能先渲染成加载骨架/空态,再换成表格;ref 一变就重挂。
    watch(el, (next, previous) => {
      if (next === previous) return
      detach()
      attach()
    })
  })
  onBeforeUnmount(detach)

  return { edges, measure }
}
