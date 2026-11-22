import { requestLogContext } from '../../../core/lib/logging'
import { createCoreRouteHandler } from '../../../core/server/utils/core-route'
import { handlePostgresRosterImportRequest, type RosterImportAction } from './roster-import-http'

export function createRosterImportHandler(action: RosterImportAction) {
  return defineEventHandler(event => createCoreRouteHandler(
    (request, ctx) => handlePostgresRosterImportRequest(action, request, ctx),
    () => ({ apiToken: useRuntimeConfig().apiToken, filesDir: useRuntimeConfig().filesDir, logContext: requestLogContext(event) }),
  )(event))
}
