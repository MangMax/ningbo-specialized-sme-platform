import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../db/postgresql/client'
import { closeTaskCenterEvents, stopJobs } from '../../layers/core/server/public'
import { validateRuntimeMode } from '../../db/runtime-mode'

export default defineNitroPlugin(nitro => {
  validateRuntimeMode()
  usePostgresDirectoryDb()

  // The Node preset waits for active HTTP responses before calling its close hook.
  // End SSE on the same signals so open streams don't hold up graceful shutdown.
  const signals = process.env.NODE_ENV === 'production' && !process.env.NITRO_SHUTDOWN_DISABLED
    ? (process.env.NITRO_SHUTDOWN_SIGNALS || 'SIGTERM SIGINT').split(' ').map(signal => signal.trim()).filter(Boolean)
    : []
  const closeStreams = () => { void closeTaskCenterEvents() }
  for (const signal of signals) process.prependListener(signal as NodeJS.Signals, closeStreams)

  nitro.hooks.hook('close', async () => {
    for (const signal of signals) process.off(signal as NodeJS.Signals, closeStreams)
    try {
      await Promise.all([closeTaskCenterEvents(), stopJobs()])
    } finally {
      await closePostgresDirectoryDb()
    }
  })
})
