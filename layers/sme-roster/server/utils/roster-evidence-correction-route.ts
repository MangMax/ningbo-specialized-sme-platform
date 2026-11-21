import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { handlePostgresOfficialEvidenceRead } from './official-evidence-read-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { handleEvidenceCorrectionRequest, type EvidenceCorrectionAction } from './roster-evidence-correction-api'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
export function evidenceCorrectionRoute(action: EvidenceCorrectionAction) {
  return semanticRouteHandler(`maintenance.evidence.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (getMethod(event) === 'POST') {
      try { body = await readBody(event) } catch {
        setResponseStatus(event, 400)
        return { error: { code: 'invalid_request', message: 'Malformed JSON request body' } }
      }
    }
    const config = useRuntimeConfig()
    const headers = { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }, query = getQuery(event)
    // New sensitive reads must be admitted before even a cold accessor can open/migrate a DB.
    if (action === 'get' && 'official' in query && !resolveApiAuth({ given: readApiToken(headers), configured: config.apiToken }).writeAuthorized) {
      setResponseStatus(event, 401)
      setHeader(event, 'content-type', 'application/json; charset=utf-8')
      return { error: { code: 'unauthorized', message: 'Configured token required' } }
    }
    const read = action === 'get' || action === 'audit' || action === 'batch'
    const native = read ? usePostgresRosterDb() : undefined
    const legacy = read && !native ? useDb() : undefined
    const output = native && action !== 'preflight' && action !== 'commit'
      ? await handlePostgresOfficialEvidenceRead({ kind: 'evidence', action, method: getMethod(event), headers, query, id: getRouterParam(event, 'id'), key: getRouterParam(event, 'key') }, { db: native, apiToken: config.apiToken })
      : await handleEvidenceCorrectionRequest({ action, method: getMethod(event), headers, body, query, id: getRouterParam(event, 'id'), key: getRouterParam(event, 'key') }, { get db() { return legacy ?? useDb() }, apiToken: config.apiToken, filesDir: config.filesDir })
    setResponseStatus(event, output.status)
    for (const [name, value] of Object.entries(output.headers)) setHeader(event, name, value)
    return output.body
  })
}
