import { join } from 'node:path'
import { nativeAppAdapter } from '../../../support/native-app'

export function comparisonAppFixture(dir: string, token: string) {
  const curatedPath = join(dir, 'curated.json')
  const reconcilePath = join(dir, 'reconcile.json')
  const app = nativeAppAdapter({
    dir, token,
    launch: ({ cwd, port }) => ({
      args: [join(cwd, '.output/server/index.mjs')],
      env: {
        NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
        NUXT_RECONCILE_PATH: reconcilePath, NUXT_CURATED_PATH: curatedPath,
      },
    }),
  })
  return { app, reconcilePath }
}
