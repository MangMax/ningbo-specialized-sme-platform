import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@db': fileURLToPath(new URL('./db', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
