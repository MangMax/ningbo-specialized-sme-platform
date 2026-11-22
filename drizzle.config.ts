import { defineConfig } from 'drizzle-kit'

const url = process.env.NUXT_POSTGRES_DIRECTORY_URL
if (!url) throw new Error('NUXT_POSTGRES_DIRECTORY_URL is required for Drizzle Studio')

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/postgresql/*-table*.ts',
  dbCredentials: { url },
})
