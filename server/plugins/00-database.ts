import { useApplicationDb } from '../../db/client'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../db/postgresql/client'
import { stopPostgresJobs } from '../../layers/core/server/public'

export default defineNitroPlugin(nitro => {
  useApplicationDb()
  if (usePostgresDirectoryDb()) nitro.hooks.hook('close', async () => {
    try {
      await stopPostgresJobs()
    } finally {
      await closePostgresDirectoryDb()
    }
  })
})
