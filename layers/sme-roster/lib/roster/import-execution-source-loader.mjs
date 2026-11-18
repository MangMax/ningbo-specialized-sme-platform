import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// A file entry avoids leaking --input-type=module into evlog's CommonJS eval worker.
const require = createRequire(import.meta.resolve('nuxt/package.json'))
const { createJiti } = require('jiti')
const entry = fileURLToPath(new URL('./import-execution-worker.ts', import.meta.url))
await createJiti(entry).import(entry)
