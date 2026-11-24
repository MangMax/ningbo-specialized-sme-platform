import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    {
      // Nuxt 在编译期把 `import.meta.dev` 替换成布尔值;裸 vitest 没有这层替换。
      // 只有开发态专用的 `/design-tokens` 预览页靠它决定是否 404,所以只在这个
      // 文件里按开发态求值 —— 服务端的生产守卫(`openapi-prod-guard` 等)保持
      // 读不到该宏时的原样,不被测试环境顺带「打开」。
      name: 'nuxt-dev-flag',
      transform(code, id) {
        if (!id.replace(/\\/g, '/').endsWith('/layers/core/app/pages/design-tokens.vue')) return
        return { code: code.replaceAll('import.meta.dev', 'true'), map: null }
      },
    },
  ],
  resolve: {
    alias: {
      // Exercise the same router version that Nuxt owns (not a second test-only router).
      'vue-router': createRequire(import.meta.resolve('nuxt/package.json')).resolve('vue-router'),
      '~': fileURLToPath(new URL('.', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '#core': fileURLToPath(new URL('./layers/core', import.meta.url)),
      '#sme-roster': fileURLToPath(new URL('./layers/sme-roster', import.meta.url)),
      '@db': fileURLToPath(new URL('./db', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Nitro 的编译期宏(`defineRouteMeta`)在裸 node 里不存在,而有些用例会直接
    // import 路由文件 —— 垫片见 `tests/setup.ts`,只影响测试进程。
    setupFiles: ['tests/setup.ts'],
    projects: [
      { extends: true, test: { name: 'runtime', include: ['tests/**/*.test.ts'], exclude: ['tests/**/*.app.test.ts', 'tests/**/*.upgrade.test.ts'] } },
      { extends: true, test: { name: 'upgrade', include: ['tests/**/*.upgrade.test.ts'] } },
      { extends: true, test: { name: 'app', include: ['tests/**/*.app.test.ts'], exclude: ['tests/runtime/development/nuxt-runtime-watch.http.app.test.ts'] } },
      { extends: true, test: { name: 'deep', include: ['tests/runtime/development/nuxt-runtime-watch.http.app.test.ts'] } },
    ],
  },
})
