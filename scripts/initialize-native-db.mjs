import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { initializeDb } = await jiti.import(new URL('../db/client.ts', import.meta.url).pathname)
const db = initializeDb({ create: true, dbPath: process.argv[2] })
console.log(`Native database ready: ${db.$client.name}`)
db.$client.close()
