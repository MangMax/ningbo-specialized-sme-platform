import { createPostgresLogStorage, PostgresLogError } from './postgres-storage'
import { createBufferedLogService, LogServiceError, type LogServiceOptions } from './service'

interface PostgresLogServiceOptions extends LogServiceOptions {
  postgresUrl: string
  postgresSchema?: string
}

export function createPostgresLogService(options: PostgresLogServiceOptions) {
  return createBufferedLogService(options, ({ maxEventBytes, timeoutMs }) => {
    const postgres = createPostgresLogStorage(options.postgresUrl, maxEventBytes, timeoutMs, !!options.stdout, options.postgresSchema)
    const postgresRequests = new Set<AbortController>()
    function call<T>(action: string, data?: unknown): Promise<T> {
      const controller = new AbortController()
      postgresRequests.add(controller)
      return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(new LogServiceError('drain_timeout', 503, action === 'write' ? 'unknown' : 'not_written'))
        controller.signal.addEventListener('abort', cancel, { once: true })
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        void postgres.execute(action, data, Date.now(), controller.signal)
          .then(result => resolve(result as T), error => reject(error instanceof PostgresLogError
            ? new LogServiceError(error.code, 503, error.writeOutcome) : new LogServiceError('storage_unavailable')))
          .finally(() => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', cancel)
            postgresRequests.delete(controller)
          })
      })
    }

    return {
      pending: () => postgresRequests.size,
      call,
      close: postgres.close,
      stop() {
        for (const request of postgresRequests) request.abort()
        void postgres.close().catch(() => {})
      },
    }
  })
}
