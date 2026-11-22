import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Controls that own their own arrow-key behavior: text fields, selects, menus,
 * tabs and switches. The global pager must never `preventDefault()` on those.
 *
 * Plain buttons/links are intentionally **not** excluded: a button does not
 * consume ←/→, and after clicking the footer pager the user should be able to
 * keep paging with the keyboard. The page-nav grid handles its own arrows and
 * calls `preventDefault()`, so `event.defaultPrevented` stops the global pager
 * before this check.
 */
function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="popover-content"]',
  )
}

/**
 * Content that scrolls on its own (wide tables, source blocks, the rendered
 * preview). ←/→ belongs to that scroller; if it were intercepted the keyboard
 * user could never reach columns 8–17 of a long table.
 */
function isScrollableContent(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    '.preview-content, .safe-preview-html, pre, [data-ocr-scroll-region]',
  )
}

interface OcrKeyboardActions {
  overlayOpen: () => boolean
  editing: () => boolean
  saving: () => boolean
  cancelEdit: () => void
  goPrev: () => void
  goNext: () => void
}

export function useOcrKeyboard({
  overlayOpen,
  editing,
  saving,
  cancelEdit,
  goPrev,
  goNext,
}: OcrKeyboardActions) {
  function onRootEscape(event: KeyboardEvent) {
    if (overlayOpen() || !editing() || saving()) return
    event.preventDefault()
    cancelEdit()
  }

  function onKeydown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      editing() ||
      overlayOpen()
    ) return
    if (isInteractiveTarget(event.target) || isScrollableContent(event.target)) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goPrev()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goNext()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { onRootEscape }
}
