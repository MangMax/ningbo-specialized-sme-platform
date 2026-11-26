import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import { installRosterWorkers } from './layers/sme-roster/nuxt-workers'
import tailwindcss from '@tailwindcss/vite'
import { LOG_ICON_IDS } from './layers/core/app/components/logs/logIcons'
import { nitroJobSchedules } from './lib/job-schedules'
import { appManifests } from './lib/installed-manifests'
import { validateAppModules } from './layers/core/lib/core/module-registry'

// Fail before serving in dev or producing a deployment with an invalid registry.
validateAppModules(appManifests)

// 只有本地图标集合；`@nuxt/icon` 在构建期把 `LOG_ICON_IDS` 与自定义集合打进客户端，
// 运行时不访问 api.iconify.design。详见 components/logs/logIcons.ts 的清单。
const projectIcons = createRequire(import.meta.url)('./layers/core/assets/icons/project-icons.json') as {
  prefix: string
  icons: Record<string, { body: string; width?: number; height?: number }>
}
const runtimeDirectories = ['data', '.runtime-logs', '.cache', '.incoming', 'files']
const runtimeWatchIgnores = runtimeDirectories.map(dir => `${fileURLToPath(new URL(`./${dir}`, import.meta.url))}/**`)


// SPA only — no SSR. Everything runs in the browser against Nitro server routes.
export default defineNuxtConfig({
  extends: ['./layers/core', './layers/sme-roster', './layers/lead-lists'],
  // Keep the root pages and aliases while the composition plugin lives under app/.
  srcDir: '.',
  // Concurrent owned dev fixtures must not share generated files or Nuxt's lock.
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  compatibilityDate: '2026-10-13',
  ssr: false,
  experimental: {
    webmcp: { navigate: false },
  },
  devtools: { enabled: true },
  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
    pageTransition: { name: 'page', mode: 'out-in', appear: true },
  },

  plugins: [fileURLToPath(new URL('./app/plugins/app-modules.ts', import.meta.url))],

  modules: [
    'vite-doctor/nuxt',
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vueuse/nuxt',
    // MCP tool definitions are discovered in the installed layers. The
    // application handler and transport contract live in server/mcp/index.ts.
    '@nuxtjs/mcp-toolkit',
    'evlog/nuxt',
    '@nuxt/icon',
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
    errorHandler: false, client: false,
    silent: true, pretty: false, console: false, sourceLocation: false, strip: [],
    transport: { enabled: false }, stream: false,
  },

  css: ['#core/app/assets/css/tailwind.css'],

  // tus 上传端点(server/utils/tus.ts)用到的路径与来源白名单。
  // 根目录在这里解析成绝对路径并冻进产物 —— server 端不能用 import.meta.url
  // 推路径(打包后它指向 .nuxt 入口)。生产/测试用 NUXT_FILES_DIR /
  // NUXT_INCOMING_DIR / NUXT_TUS_ALLOWED_ORIGINS 覆盖。
  runtimeConfig: {
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
    'nitro:init'(nitro) {
      if (nitro.options.dev) {
        nitro.options.handlers.push({
          route: nitro.options.openAPI?.route || '/_openapi.json',
          middleware: true,
          handler: fileURLToPath(new URL('./server/development-openapi.ts', import.meta.url)),
        })
      }
      const applicationLogging = fileURLToPath(new URL('./layers/core/server/plugins/application-logging.ts', import.meta.url))
      nitro.options.plugins = [applicationLogging, ...nitro.options.plugins.filter(plugin => plugin !== applicationLogging)]
      // The logging module's response formatter changes native API error JSON.
      // Keep its real request/error hooks, but preserve the existing error contract.
      const errorHandlers = Array.isArray(nitro.options.errorHandler) ? nitro.options.errorHandler : [nitro.options.errorHandler]
      nitro.options.errorHandler = [
        fileURLToPath(new URL('./layers/core/server/logging-error-handler.ts', import.meta.url)),
        ...errorHandlers.filter((handler): handler is string => !!handler),
      ]
    },
  },
  nitro: {
    hooks: {
      'build:config'(nitro, { rolldown }) {
        if (!rolldown) return
        installRosterWorkers(rolldown)
      },
    },
    experimental: { openAPI: true, tasks: true },
    ...nitroJobSchedules(appManifests, fileURLToPath(new URL('./server/scheduling/dispatch-task.ts', import.meta.url))),
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
    '#core': fileURLToPath(new URL('./layers/core', import.meta.url)),
    '#sme-roster': fileURLToPath(new URL('./layers/sme-roster', import.meta.url)),
  },

  // 忽略代理 worktree 与本地库目录:它们各自的 node_modules 若被 dev 文件监听扫进来
  // 会耗尽文件描述符(EMFILE: too many open files)。
  ignore: ['**/.claude/**', ...runtimeDirectories.map(dir => `/${dir}/**`)],

  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: ['**/.claude/**', ...runtimeWatchIgnores],
      },
    },
  },

})
