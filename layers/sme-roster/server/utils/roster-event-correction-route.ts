import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { handlePostgresOfficialEvidenceRead } from './official-evidence-read-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { handlePostgresEventCorrectionWrite } from './roster-event-correction-write-postgres'
import { handleEventCorrectionRequest, type EventCorrectionAction } from './roster-event-correction-api'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
export function eventCorrectionRoute(action: EventCorrectionAction) {
  return semanticRouteHandler(`maintenance.event.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (getMethod(event) === 'POST') {
      try { body = await readBody(event) }
      catch { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Malformed JSON request body' } } }
    }
    const config = useRuntimeConfig(), query = getQuery(event)
    const headers = { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }
    if (action === 'get' && 'official' in query && !resolveApiAuth({ given: readApiToken(headers), configured: config.apiToken }).writeAuthorized) {
      setResponseStatus(event, 401)
      return { error: { code: 'unauthorized', message: 'Configured API token required' } }
    }
    const input = { action, method: getMethod(event), id: getRouterParam(event, 'id'), query, body, headers }
    const native = action === 'preflight' || action === 'commit'
      ? await handlePostgresEventCorrectionWrite(action, { ...input, apiToken: config.apiToken })
      : await readNativeEvent(action, input, config.apiToken)
    const output = native ?? handleEventCorrectionRequest(input, { db: useDb(), apiToken: config.apiToken })
    setResponseStatus(event, output.status)
    return output.body
  })
}

function readNativeEvent(action: 'get' | 'audit', input: Omit<Parameters<typeof handleEventCorrectionRequest>[0], 'action'>, apiToken: string) {
  const db = usePostgresRosterDb()
  if (db) return handlePostgresOfficialEvidenceRead({ ...input, kind: 'event', action }, { db, apiToken })
}
