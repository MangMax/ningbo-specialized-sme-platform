import { fileURLToPath } from 'node:url'
import { TASK_EXPORTS } from './lib/sme-roster/task-exports'

export default defineNuxtConfig({
  components: [{
    path: fileURLToPath(new URL('./app/components', import.meta.url)),
    prefix: 'Roster',
    pathPrefix: false,
    ignore: ['**/index.ts'],
  }],
  hooks: {
    'nitro:init'(nitro) {
      // Register the lazy virtual source before Rollup constructs its plugins;
      // evaluate after handler scanning, when this build's route set is known.
      nitro.options.virtual['#current-export-routes'] = () => {
        const handlers = [...nitro.scannedHandlers, ...nitro.options.handlers]
        const routes = TASK_EXPORTS.filter(entry => handlers.some(h => h.route === entry.path && h.method === 'post'))
          .map(({ titleCode, path }) => ({ titleCode, path }))
        return `export default ${JSON.stringify(routes)}`
      }
    },
  },
})
