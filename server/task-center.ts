import { handlePostgresTaskCenter, type PostgresTaskListOptions } from '../layers/core/server/utils/task-center-postgres'

export type TaskCenterAction = 'list' | 'detail' | 'cancel' | 'retry'

let postgresListOptions: PostgresTaskListOptions | undefined

export function installTaskCenter(listOptions: PostgresTaskListOptions): void {
  postgresListOptions = listOptions
}

export const taskCenter = {
  createRoute(action: TaskCenterAction) {
    return defineEventHandler(event => handlePostgresTaskCenter(action, event, postgresListOptions))
  },
}
