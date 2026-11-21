import { installApplicationServer } from '../install-application'
import { startPostgresJobs } from '../../layers/core/server/public'
import { configurePostgresRuntime, validateRuntimeMode } from '../../db/runtime-mode'

export default defineNitroPlugin(() => {
  validateRuntimeMode()
  configurePostgresRuntime()
  installApplicationServer()
  startPostgresJobs(useRuntimeConfig().filesDir)
})
