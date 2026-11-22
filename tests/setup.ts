import { initLogger } from 'evlog'
import { beforeAll } from 'vitest'
import { installApplicationUi } from '../lib/install-application-ui'

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
