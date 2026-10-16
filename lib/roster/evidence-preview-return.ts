import { nextTick, onMounted, watch, type Ref } from 'vue'
import { isSafeBackPath } from './evidence-page'

const RETURN_STATE_KEY = 'roster:evidence-preview-return'

interface EvidencePreviewReturnState {
  back: string
  scrollY: number
}

/** Remember the ledger scroll offset when a same-tab evidence link is activated. */
export function rememberEvidencePreviewReturn(back: unknown, scrollY?: number): void {
  if (typeof window === 'undefined' || !isSafeBackPath(back)) return
  const offset = scrollY ?? window.scrollY
  if (!Number.isFinite(offset) || offset < 0) return

  try {
    const state: EvidencePreviewReturnState = { back, scrollY: offset }
    window.sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage may be unavailable in a restricted browser context; normal navigation still works.
  }
}

/** Consume a matching one-shot return offset. A stale or unsafe target is discarded. */
function takeEvidencePreviewScroll(currentPath: string): number | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(RETURN_STATE_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(RETURN_STATE_KEY)
    const state = JSON.parse(raw) as Partial<EvidencePreviewReturnState>
    if (
      !isSafeBackPath(state.back) ||
      state.back !== currentPath ||
      typeof state.scrollY !== 'number' ||
      !Number.isFinite(state.scrollY) ||
      state.scrollY < 0
    ) {
      return null
    }
    return state.scrollY
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
    const offset = takeEvidencePreviewScroll(`${window.location.pathname}${window.location.search}`)
    if (offset === null) return

    let restored = false
    let stop = () => {}
    const restore = async () => {
      if (restored || !ready.value) return
      restored = true
      stop()
      await nextTick()
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: offset, behavior: 'instant' })
      })
    }

    stop = watch(ready, () => {
      void restore()
    })
    if (ready.value) void restore()
  })
}
