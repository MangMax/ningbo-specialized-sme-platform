import { createHash } from 'node:crypto'
import { realpathSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import { addTypeTemplate } from 'nuxt/kit'
import { defineEventHandler } from 'h3'
import { installSessionFrontend, type SessionFrontendBinding, type SessionEntryProfile, type SessionMount } from './server/utils/mcp-session-runtime'
import tailwindcss from '@tailwindcss/vite'
import { TASK_EXPORTS } from './lib/task-center'
import { LOG_ICON_IDS } from './components/logs/logIcons'
import { getAppModules } from './lib/app-modules'
import { validateAppModules } from './lib/core/module-registry'

// Fail before serving in dev or producing a deployment with an invalid registry.
validateAppModules(getAppModules())

// 只有本地图标集合；`@nuxt/icon` 在构建期把 `LOG_ICON_IDS` 与自定义集合打进客户端，
// 运行时不访问 api.iconify.design。详见 components/logs/logIcons.ts 的清单。
const projectIcons = createRequire(import.meta.url)('./assets/icons/project-icons.json') as {
  prefix: string
  icons: Record<string, { body: string; width?: number; height?: number }>
}
const runtimeDirectories = ['data', '.runtime-logs', '.cache', '.incoming', 'files']
const runtimeWatchIgnores = runtimeDirectories.map(dir => `${fileURLToPath(new URL(`./${dir}`, import.meta.url))}/**`)


// Source frontend is a separate, trusted assembly axis. No header/IPC claims.
const sessionSourceProfiles = new WeakMap<object, SessionEntryProfile>()
function sessionRoutingPins() {
  try {
    const h3 = realpathSync(fileURLToPath(import.meta.resolve('h3')))
    const fromH3 = createRequire(h3)
    const pins = [
      { path: h3, sha: "bc1b89b0627a9b32f8c78479fcf943adb105afdd89daaa269c08d1a467cd4369" },
      { path: realpathSync(resolve(dirname(fromH3.resolve('ufo')), 'index.mjs')), sha: "893199faf3aafc1b2a03018de7c87738bcd78ed5153e7c2767d62e09b323b042" },
      { path: realpathSync(resolve(dirname(fromH3.resolve('radix3')), 'index.mjs')), sha: "7cde2a5cd932b73a56485f73e455d52bae375934c54300c4edbdded0cd878e42" },
    ]
    return pins.every(pin => createHash('sha256').update(readFileSync(pin.path)).digest('hex') === pin.sha)
  } catch { return false }
}
function sessionFrontendPins() {
  try {
    const require = createRequire(import.meta.resolve('nuxt/package.json'))
    const cli = dirname(dirname(realpathSync(require.resolve('@nuxt/cli/cli'))))
    const builder = realpathSync(require.resolve('@nuxt/nitro-server'))
    const core = realpathSync(fileURLToPath(import.meta.resolve('nitropack')))
    if (!sessionRoutingPins() || createHash('sha256').update(readFileSync(builder)).digest('hex') !== '5d4bea601b06d31e7a0e7cd5f0f26b373702ba0c1308ef4315b4279c7527f395' || createHash('sha256').update(readFileSync(core)).digest('hex') !== 'b6b0bd3e12f18e2830016dc37cb6c6ad4c939d14a60458634fd329b23653993a') return false
    const pins = [
      {"path": "dist/dev/index.mjs", "sha": "2403949150bbd4fdcfb69407ca88e512ff4a864139add7fe1eae7bfeb30ea969", "text": "await this.#currentNuxt.hooks.callHook(\"listen\", this.listener.server, this.listener);", "count": 1},
      {"path": "dist/dev/index.mjs", "sha": "2403949150bbd4fdcfb69407ca88e512ff4a864139add7fe1eae7bfeb30ea969", "text": "await Promise.all([typesPromise, kit.buildNuxt(this.#currentNuxt)]);", "count": 1},
      {"path": "dist/listen-BjyzPJ2X.mjs", "sha": "bddb50c7107c769c9b197d391eb61ebc88a55a5bc34679c6a1b82f5a60212894", "text": "const server = certificate ? createSecureServer(certificate, handler) : createServer(handler);", "count": 1},
    ]
    for (const pin of pins) {
      const file = realpathSync(resolve(cli, pin.path))
      if (!file.startsWith(cli + '/')) return false
      const bytes = readFileSync(file), code = bytes.toString('utf8')
      if (createHash('sha256').update(bytes).digest('hex') !== pin.sha || code.split(pin.text).length - 1 !== pin.count) return false
    }
    return JSON.parse(readFileSync(resolve(cli, 'package.json'), 'utf8')).version === '4.0.1'
  } catch { return false }
}
function actualSessionEntryProfile(nitro: any): SessionEntryProfile {
  return nitro.options.dev
    ? sessionSourceProfiles.get(nitro) ?? { kind: 'nuxt-source', mount: { baseURL: nitro.options.runtimeConfig?.app?.baseURL ?? '/', route: '/mcp-session' }, frontendReady: () => false }
    : { kind: 'direct-node', mount: { baseURL: nitro.options.runtimeConfig?.app?.baseURL ?? '/', route: '/mcp-session' } }
}

/** Preserve original toolkit factories. Unknown template shapes leave new entry closed. */
export function configureSessionVirtuals(nitro: any) {
  const helper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
  nitro.options.externals ||= {}
  nitro.options.externals.inline = [...(nitro.options.externals.inline ?? []), '@modelcontextprotocol/sdk', '@nuxtjs/mcp-toolkit']
  const virtual = nitro.options.virtual
  const transportKey = '#nuxt-mcp-toolkit/transport.mjs'
  const configKey = '#nuxt-mcp-toolkit/config.mjs'
  const originalTransport = virtual[transportKey], originalConfig = virtual[configKey]
  virtual['#mcp-session-toolkit'] = 'export default () => new Response(null,{status:503})'
  nitro.options.experimental ||= {}; nitro.options.experimental.asyncContext = true
  nitro.options.storage ||= {}
  for (const mount of ['mcp:sessions', 'mcp:sessions-meta']) {
    if (nitro.options.storage[mount] && nitro.options.storage[mount].driver !== 'memory') return
    nitro.options.storage[mount] = { driver: 'memory' }
  }
  if (typeof originalTransport !== 'function' || typeof originalConfig !== 'function') return
  let toolkit: string, provider: string
  try { toolkit = dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))); provider = realpathSync(resolve(toolkit, 'runtime/server/mcp/providers/node.js')) } catch { return }
  virtual[configKey] = (...args: any[]) => {
    const source = originalConfig(...args)
    if (typeof source !== 'string' || !source.startsWith('export default ')) return source
    let base: any
    try { base = JSON.parse(source.slice('export default '.length).replace(/;\s*$/, '')) } catch { return source }
    return `import {useEvent} from 'nitropack/runtime'; import {isSessionEvent,markSessionBinding} from ${JSON.stringify(helper)}; markSessionBinding('config');
const base=${JSON.stringify(base)}; export default new Proxy(base,{get(target,key,receiver){if(key==='sessions'){let active=false;try{active=isSessionEvent(useEvent())}catch{};return active?{...target.sessions,enabled:true,maxSessions:64}:target.sessions}return Reflect.get(target,key,receiver)}});`
  }
  virtual[transportKey] = (...args: any[]) => {
    const source = originalTransport(...args)
    if (typeof source !== 'string') return source
    const match = /^export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(source)
    if (!match || match[1]!.replace(/\.js$/, '') !== provider.replace(/\.js$/, '')) return source
    return `import native from ${JSON.stringify(provider)}; import {dispatchSessionTransport,markSessionBinding} from ${JSON.stringify(helper)}; markSessionBinding('provider'); export default (factory,event)=>dispatchSessionTransport(factory,event,native);`
  }
  virtual['#mcp-session-toolkit'] = `export {default} from ${JSON.stringify(resolve(toolkit, 'runtime/server/mcp/handler.js'))}`
}

/** Same locked overlay used by the app AND the owned SDK fixture. */
export function installSessionOverlay(nitro: any, config: any, audit: ((value: unknown) => void) | undefined, profile: SessionEntryProfile) {
        // #445: exact dependency overlays; failure disables ONLY the new route.
        // The original toolkit config/provider and legacy stateless route stay intact.
        const sessionHelper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
        nitro.options.externals ||= {}
        nitro.options.externals.inline = [...(nitro.options.externals.inline ?? []), '@modelcontextprotocol/sdk', '@nuxtjs/mcp-toolkit']
        const sessionPins: Array<{ path: string; sha: string; before: string; after: string; count: number; kind: string }> = []
        try {
          const sdk = dirname(fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js')))
          const nitroCore = dirname(fileURLToPath(import.meta.resolve('nitropack')))
          sessionPins.push({
            path: realpathSync(resolve(sdk, '../shared/protocol.js')),
            sha: '7ea9524fcde13f9bcb7ce4d1867fd28c7844b6311b43e3a816bb019a3b61e445',
            before: '            const parsed = parseWithCompat(requestSchema, request);\n            return Promise.resolve(handler(parsed, extra));',
            after: '            return observeRegisteredRequest(this, request, extra, () => {\n                const parsed = parseWithCompat(requestSchema, request);\n                return Promise.resolve(handler(parsed, extra));\n            });',
            count: 1, kind: 'protocol',
          }, {
            path: realpathSync(resolve(nitroCore, nitro.options.dev ? '../presets/_nitro/runtime/nitro-dev.mjs' : '../presets/node/runtime/node-server.mjs')),
            sha: nitro.options.dev ? '7369466a832ac75e8d98cb573e373abab751f7d6535613cadb1efda25cdc1c3d' : 'de34cd965af3b45c8a108cef1dcb0aa70fa864f44dbd5b5e92625c1e44d66d7c',
            before: 'toNodeListener(nitroApp.h3App)', after: nitro.options.dev || profile.kind === 'component' ? 'ownAllRequests(toNodeListener(nitroApp.h3App))' : `ownAllRequests(toNodeListener(nitroApp.h3App), ${JSON.stringify(profile.mount)}, ${sessionRoutingPins()})`,
            count: nitro.options.dev ? 1 : 2, kind: 'entry',
          }, {
            path: realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))), 'runtime/server/mcp/utils.js')),
            sha: 'f99d0e3fc85b947a68272c71af1b38c82effd2bc4e0c67722d4c0fbae08efc67',
            before: 'const onToolCalled = event ? (call) => callMcpHook("mcp:tool:called", { ...call, event }) : void 0;',
            after: 'const onToolCalled = event ? (call) => callMcpHook("mcp:tool:called", { ...call, event: isSessionEvent(event) ? sessionCurrentEvent() : event }) : void 0;',
            count: 1, kind: 'factory',
          })
        } catch { /* No dependency repair or fallback. New endpoint stays closed. */ }
        let sessionInvalid = sessionPins.length !== 3
        const sessionSeen = new Map<string, number>()
        config.plugins = [config.plugins, {
          name: 'mcp-session-locked-runtime',
          buildStart() { sessionSeen.clear(); sessionInvalid = sessionPins.length !== 3 },
          transform: { order: 'pre' as const, handler(code: string, id: string) {
            const pin = sessionPins.find(candidate => candidate.path === id)
            if (!pin) return
            const seen = (sessionSeen.get(pin.kind) ?? 0) + 1
            sessionSeen.set(pin.kind, seen)
            if (seen !== 1 || createHash('sha256').update(code).digest('hex') !== pin.sha || code.split(pin.before).length - 1 !== pin.count) {
              sessionInvalid = true; return
            }
            const imports = pin.kind === 'entry'
              ? `import { ownAllRequests, markSessionBinding, markSessionGraph, markSessionEntryProfile, captureSessionCredential } from ${JSON.stringify(sessionHelper)};\nimport {useRuntimeConfig as sessionStartupConfig} from 'nitropack/runtime'; captureSessionCredential(sessionStartupConfig().mcpToken);\nmarkSessionBinding('entry'); markSessionEntryProfile(${JSON.stringify(profile.kind)}); markSessionGraph('__MCP_SESSION_GRAPH_V1__');\n`
              : pin.kind === 'factory' ? `import {useEvent as sessionCurrentEvent} from 'nitropack/runtime'; import {isSessionEvent,markSessionBinding} from ${JSON.stringify(sessionHelper)}; markSessionBinding('factory');\n`
              : `import { observeRegisteredRequest, markSessionBinding } from ${JSON.stringify(sessionHelper)};\nmarkSessionBinding('protocol');\n`
            const transformed = imports + code.split(pin.before).join(pin.after)
            audit?.({ kind: pin.kind, path: id, source: code, transformed, count: pin.count })
            return { code: transformed, map: null }
          } },
          generateBundle(_options: unknown, bundle: any) {
            audit?.({ graph: Object.values(bundle).filter((chunk: any) => chunk.type === 'chunk').map((chunk: any) => ({ fileName: chunk.fileName, modules: Object.keys(chunk.modules), sha256: createHash('sha256').update(chunk.code).digest('hex') })) })
          },
          renderChunk(code: string) {
            if (!code.includes('__MCP_SESSION_GRAPH_V1__')) return
            const ready = (profile.kind !== 'nuxt-source' || profile.frontendReady()) && !sessionInvalid && sessionSeen.get('protocol') === 1 && sessionSeen.get('entry') === 1 && sessionSeen.get('factory') === 1
            return { code: code.replaceAll('__MCP_SESSION_GRAPH_V1__', ready ? 'ready' : 'invalid'), map: null }
          },
        }]
}

// SPA only — no SSR. Everything runs in the browser against Nitro server routes.
export default defineNuxtConfig({
  // Concurrent owned dev fixtures must not share generated files or Nuxt's lock.
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  compatibilityDate: '2026-10-13',
  ssr: false,
  devtools: { enabled: true },
  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
    pageTransition: { name: 'page', mode: 'out-in', appear: true },
  },

  modules: [
    'vite-doctor/nuxt',
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vueuse/nuxt',
    'nuxt-charts',
    // MCP server(票 18):声明式 —— `server/mcp/tools/*.ts` 里每个能力一个文件,
    // 模块扫出来注册到 `POST /mcp`。默认 handler(身份/说明书/写入鉴权)在
    // `server/mcp/index.ts`。
    '@nuxtjs/mcp-toolkit',
    'evlog/nuxt',
    '@nuxt/icon',
    function sessionToolkitTypes() {
      // Public addTypeTemplate registers prepare:types / nitro:prepare:types
      // references to a generated ambient file, not a runtime alias or module.
      const handler = resolve(dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))), 'runtime/server/mcp/handler.js')
      addTypeTemplate({
        filename: 'types/mcp-session-toolkit.d.ts',
        getContents: () => `declare module '#mcp-session-toolkit' {\n  const handler: typeof import(${JSON.stringify(handler)}).default\n  export default handler\n}\n`,
      }, { nuxt: true, node: true, nitro: true })
    },
  ],

  // 日志配置页的折叠面板图标（#180）。provider: 'none' + serverBundle: false
  // 关闭运行时 Iconify API 与服务端 icon 路由；品牌色保留在 svg 模式。
  icon: {
    provider: 'none',
    serverBundle: false,
    fallbackToApi: false,
    mode: 'svg',
    clientBundle: {
      scan: true,
      includeCustomCollections: true,
      icons: LOG_ICON_IDS,
      sizeLimitKb: 512,
    },
    customCollections: [projectIcons],
  },

  evlog: {
    silent: true, pretty: false, console: false, sourceLocation: false, strip: [],
    transport: { enabled: false }, stream: false,
  },

  // 统计页图表(nuxt-charts v3)。只注册用到的图表组件,缩小客户端包体。
  nuxtCharts: {
    include: ['LineChart', 'DonutChart'],
  },

  // shadcn-vue components live under components/ui/*; use bare names (<Card>, <Button>)
  // and skip the index.ts barrels so they don't collide with the .vue files.
  components: [
    {
      path: '~/components',
      pathPrefix: false,
      ignore: ['**/index.ts'],
    },
  ],

  css: ['~/assets/css/tailwind.css'],

  // tus 上传端点(server/utils/tus.ts)用到的路径与来源白名单。
  // 根目录在这里解析成绝对路径并冻进产物 —— server 端不能用 import.meta.url
  // 推路径(打包后它指向 .nuxt 入口)。生产/测试用 NUXT_FILES_DIR /
  // NUXT_INCOMING_DIR / NUXT_TUS_ALLOWED_ORIGINS 覆盖。
  runtimeConfig: {
    // 本地人工标注;生产/测试可用 NUXT_CURATED_PATH 覆盖。
    curatedPath: fileURLToPath(new URL('./data/reconciliation-curated.json', import.meta.url)),
    // 平台解释缓存(票 16):由 `../pipeline` 的 `pnpm reconcile` 写进本仓库的 `data/`
    // —— 与 roster.db 同一流向(pipeline ──写──▶ app/data,app 只读),app **不**反向依赖 pipeline。
    // 读不到就只是没有解释,比对本身不受影响。生产/测试可用 NUXT_RECONCILE_PATH 覆盖。
    reconcilePath: fileURLToPath(new URL('./data/platform-reconcile.json', import.meta.url)),
    filesDir: fileURLToPath(new URL('./files', import.meta.url)),
    incomingDir: fileURLToPath(new URL('./.incoming', import.meta.url)),
    // 跨源白名单(逗号分隔);默认只放行本机开发来源,避免 tus 默认的 `*`。
    tusAllowedOrigins:
      'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3470,http://127.0.0.1:3470',
    /**
     * MCP **写入** tool 的鉴权 token(票 18)。
     *
     * 空字符串 = **写入整体关闭**(只读 tool 不受影响)。这是有意的默认:反向默认
     * (空 = 放行)会让「忘了配」变成「静默的公开写入口」。
     *
     * 生产/测试用 `NUXT_MCP_TOKEN` 覆盖 —— **凭证不入库、不入仓库**,仓库里只有
     * `.env.example` 占位()。
     */
    mcpToken: '',
    /**
     * **HTTP 能力面**的鉴权 token(票 19):`POST /api/jobs` 与 `DELETE /api/jobs/:id`。
     *
     * 与 `mcpToken` 同一套反向默认(空 = 写/任务类整体关闭),但**是另一个变量**:
     * 两个面各一把钥匙就可以各自吊销(见 `server/utils/api-auth.ts` 顶部)。
     * 想让两边共用一个值,把两个变量设成一样即可 —— 那是配置时的选择。
     */
    apiToken: '',
    /**
     * **通路 a(在线 PaddleOCR API)的凭证**(票 14)。
     *
     * 只被 `server/utils/jobs/ocr.ts` 与 `server/api/...` 的 OCR 路径读;上传通路(b)
     * 与页图渲染**完全不需要它**。空 = 没配 —— 提交 `kind:"ocr"` 的任务会被明确挡下
     * 并告诉你配哪个变量(而不是发一个注定失败的请求出去)。
     *
     * 生产/测试用 `NUXT_OCR_TOKEN` 覆盖;**同一颗 token 也可以直接放在
     * `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN` 里**(与用户 MCP 配置同名),
     * `resolveOcrConfig` 会自动回退到它 —— 见 `server/utils/ocr-api.ts`。
     *
     * **凭证不入库、不入仓库**:`ocr_result` 的 `params` / `result` / 各列都不放它,
     * 仓库里只有 `.env.example` 的占位名(见 SPEC 的硬约束)。
     */
    ocrToken: '',
    /** 覆盖 PaddleOCR 服务地址(默认为 AIStudio 官方地址)。自建网关/本地假服务用得上。 */
    ocrBaseUrl: '',
    /** 覆盖识别模型(默认 `PaddleOCR-VL-1.6`,文档解析、直接出 markdown)。 */
    ocrModel: '',
    /** 轮询上限(毫秒)。97 页实测数分钟;默认 10 分钟。 */
    ocrPollTimeoutMs: 10 * 60 * 1000,
  },

  /**
   * **Nitro 内建的 OpenAPI**(票 19)—— 不装任何第三方生成器。
   *
   * `experimental.openAPI` 打开后,Nitro 自己注册三条开发期路由:`/_openapi.json`
   * (给**代理**读,顺着它发现整个 HTTP 能力面)、`/_scalar`(给人看的 UI)、
   * `/_swagger`。spec 是**构建期**从各路由文件里的 `defineRouteMeta({ openAPI })` 宏
   * 抽出来的(nitro 的 `handlers-meta` 插件按 AST 静态求值),运行时零开销。
   *
   * ⚠️ **生产默认关闭,本票也不开**:nitro 的判据是
   * `if (!dev && !openAPI.production) return` —— 所以**不设** `production` 就是关着。
   * 这是本票的硬约束之一:spec 会把整张接口面(含哪些接口要 token)摊开给人看,
   * 生产环境不该默认摊开。要开必须自己显式设 `production: 'runtime' | 'prerender'`
   * 并**自己加保护**(网关鉴权 / 内网),`tests/agent-http.test.ts` 里有一条断言把这个
   * 默认钉死,`_openapi.json` 在生产构建下的 404 有实测证据(见票 19)。
   *
   * `ui.scalar` 默认开(票要求 `/_scalar` 能开);`ui.swagger` **显式关掉** ——
   * 两个 UI 是同一份 spec 的两种渲染,留一个就够,少一条开发期路由。
   * (两者的 UI 都从公共 CDN 拉前端脚本,只在开发期、由人主动打开时才发生。)
   */
  hooks: {
    ready(nuxt) {
      // Hooks close over THIS public Nuxt instance, never a user header/global "current".
      const mount: SessionMount = { baseURL: nuxt.options.app.baseURL, route: '/mcp-session' }
      let frontend: SessionFrontendBinding | undefined
      nuxt.hooks.hook('listen', server => {
        const helper = fileURLToPath(new URL('./server/utils/mcp-session-runtime.ts', import.meta.url))
        const version = createHash('sha256').update(readFileSync(helper)).digest('hex')
        frontend = installSessionFrontend(server, mount, version, sessionFrontendPins())
      })
      nuxt.hooks.hook('nitro:build:before', nitro => {
        // Actual H3 app exists now. CLI publishes its handler only AFTER build;
        // the scoped first layer executes only when that app is really dispatched.
        if (!nuxt.options.dev) return
        const server = nuxt.server
        const appInstalled = !!frontend?.installed && !!server && !('handler' in server) && !('fetch' in server) && 'app' in server && frontend.bindApp(server.app, defineEventHandler)
        sessionSourceProfiles.set(nitro, { kind: 'nuxt-source', mount, frontendReady: () => appInstalled && frontend?.ready() === true })
      })
    },
    'nitro:init'(nitro) {
      configureSessionVirtuals(nitro)
      // The logging module's response formatter changes native API error JSON.
      // Keep its real request/error hooks, but preserve the existing error contract.
      const errorHandlers = Array.isArray(nitro.options.errorHandler) ? nitro.options.errorHandler : [nitro.options.errorHandler]
      nitro.options.errorHandler = [
        fileURLToPath(new URL('./server/logging-error-handler.ts', import.meta.url)),
        ...errorHandlers.filter((handler): handler is string => !!handler && !(handler.includes('/evlog/') && handler.includes('/nitro/errorHandler'))),
      ]
      // Register the lazy virtual source before Rollup constructs its plugins;
      // evaluate after handler scanning, when this build's route set is known.
      nitro.options.virtual['#current-export-routes'] = () => {
        const handlers = [...nitro.scannedHandlers, ...nitro.options.handlers]
        const routes = TASK_EXPORTS.filter(entry => handlers.some(h => h.route === entry.path && h.method === 'post'))
          .map(({ titleCode, path }) => ({ titleCode, path }))
        return `export default ${JSON.stringify(routes)}`
      }
    },
  },
  nitro: {
    hooks: {
      'rollup:before'(nitro, config) {
        installSessionOverlay(nitro, config, undefined, actualSessionEntryProfile(nitro))
        const loggingLocation = fileURLToPath(new URL('./lib/logging/sqlite-module-location.ts', import.meta.url))
        config.plugins = [config.plugins, {
          name: 'logging-native-module-location',
          transform: { order: 'post' as const, handler(_code: string, id: string) {
            if (id !== loggingLocation) return
            // Dev chunks may live in an external buildDir without project dependencies.
            // Production keeps chunk-relative lookup so the packaged output can move.
            const code = nitro.options.dev
              ? `export function resolveLoggingSqliteModule() { return ${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))}; }`
              : `import { createRequire } from 'node:module'; export function resolveLoggingSqliteModule() { return createRequire(_import_meta_url_).resolve('better-sqlite3'); }`
            return { code, map: null }
          } },
        }]
        // Emit an actual worker entry through the same dependency/external
        // packaging pipeline as the server. Rollup computes a relocatable URL
        // from the launcher's final chunk, including in Nitro dev builds.
        for (const worker of [
          { location: './server/utils/enterprise-read-worker-location.ts', entry: './lib/roster/enterprise-read-worker.ts', fileName: 'enterprise-read-worker.mjs', factory: 'createEnterpriseWorker', chunk: 'enterprise-read-model' },
          { location: './server/utils/import-execution-worker-location.ts', entry: './lib/roster/import-execution-worker.ts', fileName: 'import-execution-worker.mjs', factory: 'createImportExecutionWorker', chunk: 'import-execution-model' },
          { location: './server/utils/current-export-worker-location.ts', entry: './lib/roster/current-export-worker.ts', fileName: 'current-export-worker.mjs', factory: 'createCurrentExportWorker', chunk: 'current-export-model' },
        ]) {
          const location = fileURLToPath(new URL(worker.location, import.meta.url))
          const entry = fileURLToPath(new URL(worker.entry, import.meta.url))
          let reference: string
          const plugin = {
            name: worker.fileName,
            buildStart(this: { emitFile(file: { type: 'chunk'; id: string; fileName: string }): string }) {
              reference = this.emitFile({ type: 'chunk', id: entry, fileName: worker.fileName })
            },
            resolveFileUrl({ referenceId, relativePath }: { referenceId: string; relativePath: string }) {
              if (referenceId === reference) return `new URL(${JSON.stringify(relativePath)}, _import_meta_url_).href`
            },
            transform: {
              order: 'post' as const,
              handler(_code: string, id: string) {
                if (id !== location) return
                return { code: `import { createEnterpriseReadProcess } from ${JSON.stringify(fileURLToPath(new URL('./server/utils/enterprise-read-process.ts', import.meta.url)))};
                  export function ${worker.factory}() {
                    return createEnterpriseReadProcess(new URL(import.meta.ROLLUP_FILE_URL_${reference}));
                  }`, map: null }
              },
            },
          }
          config.plugins = [config.plugins, plugin]
          for (const output of Array.isArray(config.output) ? config.output : [config.output]) {
            if (!output) continue
            // Nitro dev normally inlines one entry. A native worker is a second
            // entry and must keep its own module graph in dev as in production.
            output.inlineDynamicImports = false
            const original = output.manualChunks
            const dependencies = new Set<string>()
            output.manualChunks = (id: string, api: { getModuleInfo(id: string): { isExternal: boolean; importedIds: string[] } | null }) => {
              if (!dependencies.size) {
                const visit = (moduleId: string) => {
                  if (dependencies.has(moduleId)) return
                  const info = api.getModuleInfo(moduleId)
                  if (!info || info.isExternal) return
                  dependencies.add(moduleId)
                  for (const imported of info.importedIds) visit(imported)
                }
                visit(entry)
              }
              // Keep the worker's complete business graph independent of Nitro's
              // app initialization chunk, preserving Nitro's normal grouping.
              if (id !== entry && dependencies.has(id)) return worker.chunk
              if (typeof original === 'function') return original(id, api)
              if (id.includes('/nitropack/dist/runtime/') || id.includes('/nitropack/dist/presets/')) return 'nitro'
            }
          }
        }
      },
    },
    experimental: { openAPI: true },
    openAPI: {
      meta: {
        title: '专精特新台账看板 — 代理 HTTP 能力面',
        description:
          '文件库与台账的 HTTP 接口。写/任务类接口需要 token(`NUXT_API_TOKEN`)。' +
          '长活走异步:`POST /api/jobs` 拿 jobId,再 `GET /api/jobs/{id}` 轮询。',
        version: '1.0.0',
      },
      // 不设 `production` —— 见上:生产默认关闭。
      ui: { swagger: false },
    },
  },

  alias: {
    '@db': fileURLToPath(new URL('./db', import.meta.url)),
  },

  // 忽略代理 worktree 与本地库目录:它们各自的 node_modules 若被 dev 文件监听扫进来
  // 会耗尽文件描述符(EMFILE: too many open files)。
  // Runtime writes are not source changes. In particular Nuxt Icon's custom
  // collection watcher reads builder:watch files as UTF-8, including SQLite
  // files unless these directories are excluded from the builder watcher.
  ignore: ['**/.claude/**', ...runtimeDirectories.map(dir => `/${dir}/**`)],

  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: ['**/.claude/**', ...runtimeWatchIgnores],
      },
    },
  },

  // DB 路径由 db/client.ts 解析(默认 <cwd>/data/roster.db,可用 NUXT_DB_PATH 覆盖)。
})
