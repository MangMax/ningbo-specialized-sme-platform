import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import tailwindcss from '@tailwindcss/vite'

// SPA only — no SSR. Everything runs in the browser against Nitro server routes.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-13',
  ssr: false,
  devtools: { enabled: true },

  modules: ['@pinia/nuxt', '@pinia/colada-nuxt', '@vueuse/nuxt'],

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

  vite: {
    plugins: [tailwindcss()],
  },

  runtimeConfig: {
    dbPath: process.env.NUXT_DB_PATH || './data/roster.db',
  },
})
