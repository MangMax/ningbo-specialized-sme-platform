import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // 只有组件用例(`tests/image-preview.test.ts`)需要它;它按扩展名只处理 `.vue`,
  // 对既有的纯 node 用例没有任何影响(那些文件里没有 .vue 依赖)。
  plugins: [vue()],
  resolve: {
    alias: {
      // Exercise the same router version that Nuxt owns (not a second test-only router).
      'vue-router': createRequire(import.meta.resolve('nuxt/package.json')).resolve('vue-router'),
      '~': fileURLToPath(new URL('.', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '@db': fileURLToPath(new URL('./db', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Nitro 的编译期宏(`defineRouteMeta`)在裸 node 里不存在,而有些用例会直接
    // import 路由文件 —— 垫片见 `tests/setup.ts`,只影响测试进程。
    setupFiles: ['tests/setup.ts'],
  },
})
