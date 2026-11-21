import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { getQuery, getRouterParam, readBody, setHeader } from 'h3'
import { useDb } from '@db'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { EnterpriseProfileError, getEnterpriseProfile, getEnterpriseProfileHistory, patchEnterpriseProfile } from './enterprise-profile'
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
      if (action === 'get') return pg ? await getPostgresEnterpriseProfile(pg, id) : getEnterpriseProfile(useDb(), id)
      if (action === 'history') return pg ? await getPostgresEnterpriseProfileHistory(pg, id, getQuery(event)) : getEnterpriseProfileHistory(useDb(), id, getQuery(event))
      let body: unknown
      try { body = await readBody(event) } catch { throw new EnterpriseProfileError(400, 'invalid_request', 'Malformed JSON') }
      return pg ? await patchPostgresEnterpriseProfile(pg, id, body) : patchEnterpriseProfile(useDb(), id, body)
    } catch (error) {
      if (error instanceof EnterpriseProfileError) {
        event.node.res.statusCode = error.statusCode
        return { error: { code: error.code, message: error.message } }
      }
      throw error
    }
  })
}
