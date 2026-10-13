import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import tailwindcss from '@tailwindcss/vite'

// SPA only — no SSR. Everything runs in the browser against Nitro server routes.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-13',
  ssr: false,
  devtools: { enabled: true },

  modules: ['@pinia/nuxt', '@pinia/colada-nuxt', '@vueuse/nuxt', 'nuxt-charts'],

  // 统计页图表(nuxt-charts v3)。只注册用到的图表组件,缩小客户端包体。
  nuxtCharts: {
    include: ['BarChart', 'LineChart', 'DonutChart'],
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
