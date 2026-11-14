import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  dbCredentials: {
    url: process.env.NUXT_DB_PATH || './data/roster.db',
  },
})
