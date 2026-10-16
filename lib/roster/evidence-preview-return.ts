import { nextTick, onMounted, watch, type Ref } from 'vue'
import { isSafeBackPath } from './evidence-page'

const RETURN_STATE_KEY = 'roster:evidence-preview-return'

interface EvidencePreviewReturnState {
  back: string
  scrollY: number
  scrollTop: number | null
}

/** Remember both ledger scroll layers when a same-tab evidence link is activated. */
export function rememberEvidencePreviewReturn(back: unknown, source?: EventTarget | null): void {
  if (typeof window === 'undefined' || !isSafeBackPath(back)) return
  const scrollY = window.scrollY
  if (!Number.isFinite(scrollY) || scrollY < 0) return

  const sourceElement = typeof Element !== 'undefined' && source instanceof Element ? source : null
  const scrollContainer = sourceElement?.closest<HTMLElement>('[data-evidence-return-scroll-container]') ?? null
  const scrollTop = scrollContainer?.scrollTop ?? null
  if (scrollTop !== null && (!Number.isFinite(scrollTop) || scrollTop < 0)) return

  try {
    const state: EvidencePreviewReturnState = { back, scrollY, scrollTop }
    window.sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage may be unavailable in a restricted browser context; normal navigation still works.
  }
}

/** Consume a matching one-shot return offset. A stale or unsafe target is discarded. */
function takeEvidencePreviewScroll(currentPath: string): EvidencePreviewReturnState | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(RETURN_STATE_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(RETURN_STATE_KEY)
    const state = JSON.parse(raw) as Partial<EvidencePreviewReturnState>
    if (
      !isSafeBackPath(state.back, window.location.origin) ||
      state.back !== currentPath ||
      typeof state.scrollY !== 'number' ||
      !Number.isFinite(state.scrollY) ||
      state.scrollY < 0 ||
      (state.scrollTop !== undefined &&
        state.scrollTop !== null &&
        (typeof state.scrollTop !== 'number' || !Number.isFinite(state.scrollTop) || state.scrollTop < 0))
    ) {
      return null
    }
    return { back: state.back, scrollY: state.scrollY, scrollTop: state.scrollTop ?? null }
  } catch {
    return null
  }
}

/**
 * Restore the saved offset after the destination view has received data and rendered it.
 * `ready` belongs to the caller so the ledger can wait for its active filtered query.
 */
export function useEvidencePreviewScrollRestore(ready: Readonly<Ref<boolean>>): void {
  onMounted(() => {
    const state = takeEvidencePreviewScroll(`${window.location.pathname}${window.location.search}`)
    if (state === null) return

    let restored = false
    let stop = () => {}
    const restore = async () => {
      if (restored || !ready.value) return
      restored = true
      stop()
      await nextTick()
      window.requestAnimationFrame(() => {
        if (state.scrollTop !== null) {
          const tableScroller = document.querySelector<HTMLElement>('[data-evidence-return-scroll-container]')
          if (tableScroller) tableScroller.scrollTop = state.scrollTop
        }
        window.scrollTo({ top: state.scrollY, behavior: 'instant' })
      })
    }

    stop = watch(ready, () => {
      void restore()
    })
    if (ready.value) void restore()
  })
}
