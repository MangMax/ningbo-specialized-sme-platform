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
