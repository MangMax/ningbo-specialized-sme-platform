import { fileURLToPath } from 'node:url'
import { addTypeTemplate } from 'nuxt/kit'
import { TASK_EXPORTS } from './lib/sme-roster/task-exports'

export default defineNuxtConfig({
  modules: [
    function registerExportRouteTypes() {
      addTypeTemplate({
        filename: 'types/current-export-routes.d.ts',
        src: fileURLToPath(new URL('./types/current-export-routes.d.ts', import.meta.url)),
      }, { nuxt: true, nitro: true })
    },
  ],
  components: [{
    path: fileURLToPath(new URL('./app/components', import.meta.url)),
    prefix: 'Roster',
    pathPrefix: false,
    ignore: ['**/index.ts'],
  }],
  hooks: {
    'nitro:init'(nitro) {
      // Register the lazy virtual source before the builder constructs its plugins;
      // evaluate after handler scanning, when this build's route set is known.
      nitro.options.virtual['#current-export-routes'] = () => {
        const handlers = [...nitro.scannedHandlers, ...nitro.options.handlers]
        const routes = TASK_EXPORTS.filter(entry => handlers.some(h => h.route === entry.path && h.method?.toUpperCase() === 'POST'))
          .map(({ titleCode, path }) => ({ titleCode, path }))
        return `export default ${JSON.stringify(routes)}`
      }
    },
  },
})
