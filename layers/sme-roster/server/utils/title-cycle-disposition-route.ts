import { getQuery, readBody, setHeader, setResponseStatus } from 'h3'
import { semanticRouteHandler } from '../../../core/server/utils/core-route'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { runtimeDispositionOperation, dispositionFailure, type DispositionAction } from './title-cycle-disposition-protocol'
export function dispositionRoute(action: DispositionAction) {
 return semanticRouteHandler(`maintenance.disposition.${action}`, async event => {
  setHeader(event,'cache-control','no-store')
  if (action === 'preflight' || action === 'commit') requireApiToken(event)
  try {
   let body: unknown
   if (action === 'current' || action === 'history') {
    const query = getQuery(event)
    body = {...query, enterpriseIds: typeof query.enterpriseIds === 'string' ? query.enterpriseIds.split(',').map(v => /^\d+$/.test(v) ? Number(v) : v) : query.enterpriseIds}
   } else {
    try { body = await readBody(event) } catch { setResponseStatus(event,400); return {error:{code:'invalid_request',message:'Malformed JSON'}} }
   }
   return await runtimeDispositionOperation(action,body)
  } catch(error) { const failure = dispositionFailure(error); setResponseStatus(event,failure.status); return failure.body }
 })
}
