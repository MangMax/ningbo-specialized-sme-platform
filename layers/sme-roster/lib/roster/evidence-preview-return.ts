import { nextTick, onMounted, onScopeDispose, watch, type Ref } from 'vue'
import { ROSTER_LEDGER_PATH } from '../sme-roster/routes'
import { isSafeBackPath } from '../../../core/lib/preview-query'
import { scrollWorkspaceTo, workspaceScrollTop } from '../../../core/lib/workspace-scroll'

const RETURN_STATE_KEY = 'roster:evidence-preview-return'
const HISTORY_RETURN_PATH_KEY = '__rosterEvidencePreviewReturnPath'

export interface EvidencePreviewReturnAnchor {
  eventId: string
  viewportTop: number
}

interface EvidencePreviewReturnState {
  back: string
  scrollY: number
  scrollTop: number | null
  scrollLeft: number | null
  anchor?: EvidencePreviewReturnAnchor
  focusKey?: string
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
      ([key, entryValue]) => !(url.pathname === ROSTER_LEDGER_PATH && key === 'view' && entryValue === 'enterprise'),
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
  if (fromPath === '/preview' || /^\/enterprises\/\d+$/.test(fromPath)) {
    consumeHistoryReturnPath(toFullPath)
    return false
  }
  if (consumeHistoryReturnPath(toFullPath)) return false
  return !hasEvidencePreviewReturn(toFullPath)
}

/**
 * Nuxt 4.6 wraps `scrollBehavior` with START_LOCATION as `from`, and its callback can run after
 * the ready-state hook consumed sessionStorage. Keep a one-shot marker on the browser history
 * entry itself so the delayed callback can still suppress `{ top: 0 }` on a real Back traversal.
 */
function consumeHistoryReturnPath(toFullPath: string): boolean {
  if (typeof window === 'undefined') return false
  const toKey = returnPathKey(toFullPath)
  const current = window.history.state
  if (
    toKey === null ||
    !current ||
    typeof current !== 'object' ||
    current[HISTORY_RETURN_PATH_KEY] !== toKey
  ) return false

  const next = { ...current }
  delete next[HISTORY_RETURN_PATH_KEY]
  try {
    window.history.replaceState(next, '', window.location.href)
  } catch {
    // A restricted browser may refuse state replacement; scroll suppression still applies once.
  }
  return true
}

function rememberHistoryReturnPath(back: string): void {
  if (typeof window === 'undefined') return
  const backKey = returnPathKey(back)
  if (backKey === null) return

  const current = window.history.state
  const next = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : {}
  next[HISTORY_RETURN_PATH_KEY] = backKey
  try {
    window.history.replaceState(next, '', window.location.href)
  } catch {
    // Session state remains available for the normal in-app return path.
  }
}

/** Remember the workspace and ledger scroll offsets when a same-tab evidence link is activated. */
export function rememberEvidencePreviewReturn(back: unknown, source?: EventTarget | null): void {
  if (typeof window === 'undefined' || !isSafeBackPath(back)) return
  const scrollY = workspaceScrollTop()
  if (!Number.isFinite(scrollY) || scrollY < 0) return

  const sourceElement = typeof Element !== 'undefined' && source instanceof Element ? source : null
  const scrollContainer = sourceElement?.closest<HTMLElement>('[data-evidence-return-scroll-container]') ?? null
  const scrollTop = scrollContainer?.scrollTop ?? null
  const scrollLeft = scrollContainer?.scrollLeft ?? null
  if (
    (scrollTop !== null && (!Number.isFinite(scrollTop) || scrollTop < 0)) ||
    (scrollLeft !== null && (!Number.isFinite(scrollLeft) || scrollLeft < 0))
  ) return

  // The comparison opts into this anchor; numeric-only consumers retain their existing offsets.
  const eventElement = sourceElement?.closest<HTMLElement>('[data-event-id]')
  const eventId = eventElement?.dataset.eventId
  const viewportTop = eventElement?.getBoundingClientRect().top
  const anchor = eventId && viewportTop !== undefined && Number.isFinite(viewportTop) ? { eventId, viewportTop } : undefined
  try {
    const focusKey = sourceElement instanceof HTMLElement ? sourceElement.dataset.evidenceReturnFocus : undefined
    const state: EvidencePreviewReturnState = { ...(focusKey ? { focusKey } : {}), back, scrollY, scrollTop, scrollLeft, ...(anchor ? { anchor } : {}) }
    const saved = readSavedReturns().filter((entry) => entry.back !== back)
    saved.push(state)
    writeSavedReturns(saved)
    rememberHistoryReturnPath(back)
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
        ...(typeof state.focusKey === 'string' ? { focusKey: state.focusKey } : {}),
        scrollY: state.scrollY,
        scrollTop: state.scrollTop ?? null,
        scrollLeft: state.scrollLeft ?? null,
        ...(state.anchor && typeof state.anchor.eventId === 'string' && Number.isFinite(state.anchor.viewportTop) ? { anchor: state.anchor } : {}),
      }
    : null
}

/**
 * Restore the saved offset after the destination view has received data and rendered it.
 * `ready` belongs to the caller so the view can wait for all layout-changing reads.
 * An optional event resolver preserves viewport position even when disclosures remount closed.
 */
export function useEvidencePreviewScrollRestore(
  ready: Readonly<Ref<boolean>>,
  resolveAnchor?: (anchor: EvidencePreviewReturnAnchor) => number | undefined,
  destinationPath?: string,
): void {
  let active = true
  let observer: MutationObserver | undefined
  onScopeDispose(() => { active = false; observer?.disconnect() })
  onMounted(() => {
    // Nuxt can mount the destination while the browser URL still names the preview.
    const path = destinationPath ?? `${window.location.pathname}${window.location.search}`
    const state = takeEvidencePreviewScroll(path)
    if (state === null) return

    let restored = false
    let scheduled = false
    let stop = () => {}
    const ownsRestore = () => active && ready.value && returnPathKey(`${window.location.pathname}${window.location.search}`) === returnPathKey(path)
    const restore = async () => {
      if (restored || scheduled || !ownsRestore()) return
      scheduled = true
      await nextTick()
      window.requestAnimationFrame(() => {
        scheduled = false
        if (!ownsRestore()) return
        if (state.scrollTop !== null) {
          const tableScroller = document.querySelector<HTMLElement>('[data-evidence-return-scroll-container]')
          if (tableScroller) {
            tableScroller.scrollTop = state.scrollTop
            if (state.scrollLeft !== null) tableScroller.scrollLeft = state.scrollLeft
          }
        }
        const anchoredY = state.anchor ? resolveAnchor?.(state.anchor) : undefined
        const top = anchoredY !== undefined && Number.isFinite(anchoredY) ? Math.max(0, anchoredY) : state.scrollY
        scrollWorkspaceTo(top)
        restored = true
        stop()
        // HEAD availability can mount the source link after the surrounding event is ready.
        const focusSource = () => {
          if (!ownsRestore()) { observer?.disconnect(); return }
          const link = [...document.querySelectorAll<HTMLElement>('[data-evidence-return-focus]')].find(element =>
            element.dataset.evidenceReturnFocus === state.focusKey &&
            (!state.anchor || element.closest<HTMLElement>('[data-event-id]')?.dataset.eventId === state.anchor.eventId))
          if (link) { link.focus({ preventScroll: true }); observer?.disconnect() }
          return !!link
        }
        if (state.focusKey && !focusSource()) {
          observer = new MutationObserver(focusSource)
          observer.observe(document.body, { childList: true, subtree: true })
        }
      })
    }

    stop = watch(ready, () => { void restore() })
    if (ready.value) void restore()
  })
}
