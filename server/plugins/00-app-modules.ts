import { installApplicationServer } from '../install-application'
import { startPostgresJobs } from '../../layers/core/server/public'

export default defineNitroPlugin(() => {
  installApplicationServer()
  startPostgresJobs(useRuntimeConfig().filesDir)
})
