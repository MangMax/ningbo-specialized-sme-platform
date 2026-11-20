import { postgresJobsEnabled } from '../layers/core/server/utils/postgres-jobs'
import { handlePostgresTaskCenter } from '../layers/core/server/utils/task-center-postgres'
import type { H3Event } from 'h3'

export type TaskCenterAction = 'list' | 'detail' | 'cancel' | 'retry'
type TaskCenterHandler = (action: TaskCenterAction, event: H3Event) => Promise<unknown>

let handler: TaskCenterHandler | undefined

export function installTaskCenter(handle: TaskCenterHandler): void {
  handler = handle
}

export const taskCenter = {
  createRoute(action: TaskCenterAction) {
    return defineEventHandler(event => {
      if (postgresJobsEnabled()) return handlePostgresTaskCenter(action, event)
      if (!handler) throw createError({ statusCode: 501, statusMessage: 'Task center has not been installed' })
      return handler(action, event)
    })
  },
}
