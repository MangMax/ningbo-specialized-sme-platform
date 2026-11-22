import { installApplicationServer } from '../install-application'
import { startPostgresJobs } from '../../layers/core/server/public'
import { validateRuntimeMode } from '../../db/runtime-mode'

export default defineNitroPlugin(() => {
  validateRuntimeMode()
  installApplicationServer()
  startPostgresJobs(useRuntimeConfig().filesDir)
})
