import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { EnterpriseProfileError } from './enterprise-profile-model'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { getPostgresEnterpriseProfile, getPostgresEnterpriseProfileHistory, patchPostgresEnterpriseProfile } from './enterprise-profile-postgres'

export function enterpriseProfileRoute(action: 'get' | 'patch' | 'history') {
  return semanticRouteHandler(`maintenance.enterprise_profile.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action === 'patch') requireApiToken(event)
    try {
      const raw = getRouterParam(event, 'id') ?? '', id = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isSafeInteger(id) || id < 1) throw new EnterpriseProfileError(400, 'invalid_request', 'Positive enterprise ID required')
      const pg = usePostgresDirectoryDb()
      if (action === 'get') return await getPostgresEnterpriseProfile(pg, id)
      if (action === 'history') return await getPostgresEnterpriseProfileHistory(pg, id, getQuery(event))
      let body: unknown
      try { body = await readBody(event) } catch { throw new EnterpriseProfileError(400, 'invalid_request', 'Malformed JSON') }
      return await patchPostgresEnterpriseProfile(pg, id, body)
    } catch (error) {
      if (error instanceof EnterpriseProfileError) {
        setResponseStatus(event, error.statusCode)
        return { error: { code: error.code, message: error.message } }
      }
      throw error
    }
  })
}
