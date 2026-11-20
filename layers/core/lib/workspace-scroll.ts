function workspaceScroller() {
  return document.querySelector<HTMLElement>('[data-workspace-scroll]')
}

export function workspaceScrollTop() {
  return workspaceScroller()?.scrollTop ?? window.scrollY
}

export function scrollWorkspaceTo(top: number) {
  const scroller = workspaceScroller()
  if (scroller) scroller.scrollTo({ top, behavior: 'instant' })
  else window.scrollTo({ top, behavior: 'instant' })
}
