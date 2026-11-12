import { createRequire } from 'node:module'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
await createJiti(import.meta.url,{fsCache:false,moduleCache:false}).import('./candidate-scope-cli.ts')
