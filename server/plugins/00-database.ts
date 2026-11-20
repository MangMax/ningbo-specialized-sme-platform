import { useApplicationDb } from '../../db/client'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../db/postgresql/client'
import { stopPostgresJobs } from '../../layers/core/server/public'
import { postgresOnlyRuntime, validateRuntimeMode } from '../../db/runtime-mode'
import { closePostgresReviewSnapshots } from '../../layers/sme-roster/server/utils/evidence-review-reads-postgres'

export default defineNitroPlugin(nitro => {
  validateRuntimeMode()
  if (!postgresOnlyRuntime()) useApplicationDb()
  if (usePostgresDirectoryDb()) nitro.hooks.hook('close', async () => {
    try {
      await Promise.all([stopPostgresJobs(), closePostgresReviewSnapshots()])
    } finally {
      await closePostgresDirectoryDb()
    }
  })
})
