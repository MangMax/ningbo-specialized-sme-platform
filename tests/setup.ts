import { initLogger } from 'evlog'
import { beforeAll } from 'vitest'
import { installApplicationUi } from '../lib/install-application-ui'

if (typeof window !== 'undefined') {
  // jsdom has no viewport layout or pointer capture. Interaction tests can
  // override these defaults when they need to observe scrolling or media state.
  window.matchMedia ??= (media) => Object.assign(new EventTarget(), {
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
  })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  HTMLElement.prototype.scrollTo ??= function (optionsOrX?: ScrollToOptions | number, y?: number) {
    const { left, top } = typeof optionsOrX === 'number'
      ? { left: optionsOrX, top: y }
      : optionsOrX ?? {}
    if (left !== undefined) this.scrollLeft = left
    if (top !== undefined) this.scrollTop = top
  }
  Element.prototype.hasPointerCapture ??= () => false
}

installApplicationUi()
beforeAll(async () => {
  const { installApplicationServer } = await import('../server/install-application')
  installApplicationServer()
})

initLogger({ enabled: true, silent: true, pretty: false, drain: () => {} })
;(globalThis as unknown as Record<string, unknown>).defineRouteMeta = (meta: unknown) => meta

;(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.useHead ??= () => {}
  const bridge: { current: unknown } = { current: null }
  g.__routerBridge = bridge
  type RouterLike = ReturnType<typeof import('vue-router')['useRouter']>
  void import('vue-router').then((lib) => {
    g.useRoute = () => (bridge.current as RouterLike | null)?.currentRoute?.value ?? lib.useRoute()
    g.useRouter = () => (bridge.current as RouterLike | null) ?? lib.useRouter()
  })
})()
