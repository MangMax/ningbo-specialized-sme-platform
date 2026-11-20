import { postgresJobStorageEnabled } from '../layers/core/server/utils/postgres-jobs'
import { handlePostgresTaskCenter, type PostgresTaskListOptions } from '../layers/core/server/utils/task-center-postgres'
import type { H3Event } from 'h3'

export type TaskCenterAction = 'list' | 'detail' | 'cancel' | 'retry'
type TaskCenterHandler = (action: TaskCenterAction, event: H3Event) => Promise<unknown>

let handler: TaskCenterHandler | undefined
let postgresListOptions: PostgresTaskListOptions | undefined

export function installTaskCenter(handle: TaskCenterHandler, listOptions?: PostgresTaskListOptions): void {
  handler = handle
  postgresListOptions = listOptions
}

export const taskCenter = {
  createRoute(action: TaskCenterAction) {
    return defineEventHandler(event => {
      if (postgresJobStorageEnabled()) return handlePostgresTaskCenter(action, event, postgresListOptions)
      if (!handler) throw createError({ statusCode: 501, statusMessage: 'Task center has not been installed' })
      return handler(action, event)
    })
  },
}
