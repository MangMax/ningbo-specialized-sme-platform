// Install the existing task-center read and action surface for this application.
import { createTaskCenterRoute } from '../layers/sme-roster/server/utils/task-center-route'

export const taskCenter = { createRoute: createTaskCenterRoute }
