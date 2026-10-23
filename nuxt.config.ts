import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import tailwindcss from '@tailwindcss/vite'
import { TASK_EXPORTS } from './lib/task-center'
import { LOG_ICON_IDS } from './components/logs/logIcons'

// 只有本地图标集合；`@nuxt/icon` 在构建期把 `LOG_ICON_IDS` 与自定义集合打进客户端，
// 运行时不访问 api.iconify.design。详见 components/logs/logIcons.ts 的清单。
const projectIcons = createRequire(import.meta.url)('./assets/icons/project-icons.json') as {
  prefix: string
  icons: Record<string, { body: string; width?: number; height?: number }>
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
     * `.env.example` 占位(见 `.scratch/ingest-pipeline/SPEC.md`)。
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
    /** Sensitive log page capability; explicit opt-in, not a user identity/session. */
    browserLogsEnabled: false,
    /**
     * **#108 页面复核写入口的显式部署开关**（server-only，默认 `false`）。
     *
     * `true` 且 `apiToken` 非空时，才允许同源页面通过
     * `POST /api/roster/evidence-review/browser-commands` 提交 maintain/replace。
     * 这是过渡的**部署能力**（“允许该应用的页面进行人工复核”），**不是登录鉴权**：
     * 它不识别操作人、不建立会话，也不把同源本身当身份。默认关闭时，同源请求同样拒绝。
     * token 仍只用于判断既有写能力是否配置，不返回浏览器、不写入 cookie/Web Storage。
     * 真实权限体系与操作人来源见 #127；届时替换此开关。
     */
    browserReviewEnabled: false,
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
  ignore: ['**/.claude/**', '**/data/**'],

  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: ['**/.claude/**', '**/data/**'],
      },
    },
  },

  // DB 路径由 db/client.ts 解析(默认 <cwd>/data/roster.db,可用 NUXT_DB_PATH 覆盖)。
})
