// Use Nuxt's existing pinned loader; no install or shared dependency/cache writes.
import { createRequire } from 'node:module'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
await createJiti(import.meta.url, { fsCache: false, moduleCache: false }).import('./cli.ts')
