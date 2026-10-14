import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
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
