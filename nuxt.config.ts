import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import tailwindcss from '@tailwindcss/vite'

// SPA only — no SSR. Everything runs in the browser against Nitro server routes.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-13',
  ssr: false,
  devtools: { enabled: true },

  modules: [
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vueuse/nuxt',
    'nuxt-charts',
    // MCP server(票 18):声明式 —— `server/mcp/tools/*.ts` 里每个能力一个文件,
    // 模块扫出来注册到 `POST /mcp`。默认 handler(身份/说明书/写入鉴权)在
    // `server/mcp/index.ts`。
    '@nuxtjs/mcp-toolkit',
  ],

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
  nitro: {
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
