import { useApplicationDb } from '../../db/client'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../db/postgresql/client'

export default defineNitroPlugin(nitro => {
  useApplicationDb()
  if (usePostgresDirectoryDb()) nitro.hooks.hook('close', closePostgresDirectoryDb)
})
