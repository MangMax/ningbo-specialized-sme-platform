import { fileURLToPath } from 'node:url'
import { TASK_EXPORTS } from './lib/sme-roster/task-exports'

export default defineNuxtConfig({
  components: [{
    path: fileURLToPath(new URL('./app/components', import.meta.url)),
    prefix: 'Roster',
    pathPrefix: false,
    ignore: ['**/index.ts'],
  }],
  runtimeConfig: {
    // 本地人工标注;生产/测试可用 NUXT_CURATED_PATH 覆盖。
    curatedPath: fileURLToPath(new URL('../../data/reconciliation-curated.json', import.meta.url)),
    // 平台解释缓存(票 16):由 `../pipeline` 的 `pnpm reconcile` 写进本仓库的 `data/`
    // —— 与 roster.db 同一流向(pipeline ──写──▶ app/data,app 只读),app **不**反向依赖 pipeline。
    // 读不到就只是没有解释,比对本身不受影响。生产/测试可用 NUXT_RECONCILE_PATH 覆盖。
    reconcilePath: fileURLToPath(new URL('../../data/platform-reconcile.json', import.meta.url)),
  },
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
