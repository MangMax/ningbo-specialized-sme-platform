import { semanticRouteHandler } from './core-route'
import { getQuery, getRouterParam, readBody, setHeader } from 'h3'
import { useDb } from '@db'
import { requireApiToken } from './api-guard'
import { EnterpriseProfileError, getEnterpriseProfile, getEnterpriseProfileHistory, patchEnterpriseProfile } from './enterprise-profile'

export function enterpriseProfileRoute(action: 'get' | 'patch' | 'history') {
  return semanticRouteHandler(`maintenance.enterprise_profile.${action}`, async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action === 'patch') requireApiToken(event)
    try {
      const raw = getRouterParam(event, 'id') ?? '', id = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isSafeInteger(id) || id < 1) throw new EnterpriseProfileError(400, 'invalid_request', 'Positive enterprise ID required')
      if (action === 'get') return getEnterpriseProfile(useDb(), id)
      if (action === 'history') return getEnterpriseProfileHistory(useDb(), id, getQuery(event))
      let body: unknown
      try { body = await readBody(event) } catch { throw new EnterpriseProfileError(400, 'invalid_request', 'Malformed JSON') }
      return patchEnterpriseProfile(useDb(), id, body)
    } catch (error) {
      if (error instanceof EnterpriseProfileError) {
        event.node.res.statusCode = error.statusCode
        return { error: { code: error.code, message: error.message } }
      }
      throw error
    }
  })
}
