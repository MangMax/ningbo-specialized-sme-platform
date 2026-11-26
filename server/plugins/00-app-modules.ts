import { installApplicationServer } from '../install-application'
import { startJobs } from '../../layers/core/server/public'
import { validateRuntimeMode } from '../../db/runtime-mode'

export default defineNitroPlugin(() => {
  validateRuntimeMode()
  installApplicationServer()
  startJobs(useRuntimeConfig().filesDir)
})
