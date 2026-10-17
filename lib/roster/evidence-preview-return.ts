import { nextTick, onMounted, watch, type Ref } from 'vue'
import { isSafeBackPath } from './evidence-page'

const RETURN_STATE_KEY = 'roster:evidence-preview-return'

interface EvidencePreviewReturnState {
  back: string
  scrollY: number
  scrollTop: number | null
  scrollLeft: number | null
}

function validState(value: unknown): value is EvidencePreviewReturnState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<EvidencePreviewReturnState>
  return (
    typeof state.back === 'string' &&
    typeof window !== 'undefined' &&
    isSafeBackPath(state.back, window.location.origin) &&
    typeof state.scrollY === 'number' &&
    Number.isFinite(state.scrollY) &&
    state.scrollY >= 0 &&
    (state.scrollTop === undefined ||
      state.scrollTop === null ||
        (typeof state.scrollTop === 'number' && Number.isFinite(state.scrollTop) && state.scrollTop >= 0)) &&
      (state.scrollLeft === undefined ||
        state.scrollLeft === null ||
        (typeof state.scrollLeft === 'number' && Number.isFinite(state.scrollLeft) && state.scrollLeft >= 0))
  )
}

/** Keep separate offsets for each step in a ledger → detail → preview return chain. */
function readSavedReturns(): EvidencePreviewReturnState[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(RETURN_STATE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    return candidates.filter(validState)
  } catch {
    return []
  }
}

function writeSavedReturns(states: EvidencePreviewReturnState[]): void {
  if (typeof window === 'undefined') return
  try {
    if (states.length) window.sessionStorage.setItem(RETURN_STATE_KEY, JSON.stringify(states))
    else window.sessionStorage.removeItem(RETURN_STATE_KEY)
  } catch {
    // Storage may be unavailable in a restricted browser context; normal navigation still works.
  }
}

/** Canonicalize equivalent ledger URLs for history traversal, including the implicit default view. */
function returnPathKey(value: string): string | null {
  if (typeof window === 'undefined' || !isSafeBackPath(value, window.location.origin)) return null
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin) return null
    const entries = [...url.searchParams.entries()].filter(
      ([key, entryValue]) => !(url.pathname === '/' && key === 'view' && entryValue === 'enterprise'),
    )
    entries.sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    const query = new URLSearchParams(entries).toString()
    return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`
  } catch {
    return null
  }
}

/** Whether the target route has a saved offset that its own ready-state hook will restore. */
export function hasEvidencePreviewReturn(back: string): boolean {
  const backKey = returnPathKey(back)
  return backKey !== null && readSavedReturns().some((state) => returnPathKey(state.back) === backKey)
}

/**
 * Keep Nuxt's top reset out of roster return navigations. The restore composable can consume
 * session state before Vue Router asks Nuxt for its final position, so route origin is durable.
 */
export function shouldNuxtScrollToTop(toFullPath: string, fromPath: string): boolean {
  if (fromPath === '/preview' || /^\/enterprises\/\d+$/.test(fromPath)) return false
  return !hasEvidencePreviewReturn(toFullPath)
}

/** Remember both ledger scroll layers when a same-tab evidence link is activated. */
export function rememberEvidencePreviewReturn(back: unknown, source?: EventTarget | null): void {
  if (typeof window === 'undefined' || !isSafeBackPath(back)) return
  const scrollY = window.scrollY
  if (!Number.isFinite(scrollY) || scrollY < 0) return

  const sourceElement = typeof Element !== 'undefined' && source instanceof Element ? source : null
  const scrollContainer = sourceElement?.closest<HTMLElement>('[data-evidence-return-scroll-container]') ?? null
  const scrollTop = scrollContainer?.scrollTop ?? null
  const scrollLeft = scrollContainer?.scrollLeft ?? null
  if (
    (scrollTop !== null && (!Number.isFinite(scrollTop) || scrollTop < 0)) ||
    (scrollLeft !== null && (!Number.isFinite(scrollLeft) || scrollLeft < 0))
  ) return

  try {
    const state: EvidencePreviewReturnState = { back, scrollY, scrollTop, scrollLeft }
    const saved = readSavedReturns().filter((entry) => entry.back !== back)
    saved.push(state)
    writeSavedReturns(saved)
  } catch {
    // Storage may be unavailable in a restricted browser context; normal navigation still works.
  }
}

/** Consume only the matching offset; safe offsets for earlier steps in the chain remain available. */
function takeEvidencePreviewScroll(currentPath: string): EvidencePreviewReturnState | null {
  if (typeof window === 'undefined') return null

  const saved = readSavedReturns()
  const currentKey = returnPathKey(currentPath)
  const matchingIndex = currentKey === null ? -1 : saved.findIndex((state) => returnPathKey(state.back) === currentKey)
  if (matchingIndex < 0) return null
  const [state] = saved.splice(matchingIndex, 1)
  writeSavedReturns(saved)
  return state
    ? {
        back: state.back,
        scrollY: state.scrollY,
        scrollTop: state.scrollTop ?? null,
        scrollLeft: state.scrollLeft ?? null,
      }
    : null
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
          if (tableScroller) {
            tableScroller.scrollTop = state.scrollTop
            if (state.scrollLeft !== null) tableScroller.scrollLeft = state.scrollLeft
          }
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
