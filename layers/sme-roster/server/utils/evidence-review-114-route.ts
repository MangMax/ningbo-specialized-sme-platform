import { getHeader, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { DecisionError102, parse102 } from './decision-lifecycle-102/contract'
import { decisionFailure102, postgresDecisionOutput102 } from './decision-lifecycle-102-output'
import { impactList114, impactGet114, impactSources114, impactEvents114, impactPreview114, workCommand114 } from './evidence-review-114-contract'
import { usePostgresRosterDb } from './postgres-roster-db'
import { workPostgresEvidenceReview } from './evidence-review-work-postgres'

import { getPostgresImpact114, listPostgresImpacts114, listPostgresImpactSources114,
  listPostgresRevisionEvents114, previewPostgresImpacts114 } from './evidence-review-reads-postgres'

export function reviewRoute114(action:'list'|'get'|'sources'|'events'|'preview'|'commands') {
  return defineEventHandler(async(event:H3Event)=>{
    setHeader(event,'cache-control','no-store')
    try{
      if(action==='commands'){
        if(!resolveApiAuth({given:readApiToken({authorization:getHeader(event,'authorization'),'x-api-token':getHeader(event,'x-api-token')}),configured:useRuntimeConfig().apiToken}).writeAuthorized)throw new DecisionError102(401,'unauthorized','Configured API token required')
        let body:unknown;try{body=await readBody(event)}catch{throw new DecisionError102(400,'invalid_request','Malformed JSON request body')}
        const command = parse102(workCommand114, body)
        const native = usePostgresRosterDb(true)
        const output = await postgresDecisionOutput102(native)
        return output(await workPostgresEvidenceReview(native, command))
      }
      const raw={...getQuery(event),...(getRouterParam(event,'id')?{id:getRouterParam(event,'id')}:{}),...(getRouterParam(event,'revisionId')?{revisionId:getRouterParam(event,'revisionId')}:{})}
      const q=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,['enterpriseId','decisionId','eventId','revisionId','id','limit'].includes(k)&&typeof v==='string'&&/^\d+$/.test(v)?Number(v):v]))
      const postgres = usePostgresRosterDb()
      if (action === 'list') return (await postgresDecisionOutput102(postgres))(await listPostgresImpacts114(parse102(impactList114, q)))
      return await postgres.transaction(async tx => {
        const output = await postgresDecisionOutput102(tx)
        if (action === 'get') return output(await getPostgresImpact114(tx, parse102(impactGet114, q).id))
        if (action === 'sources') return output(await listPostgresImpactSources114(tx, parse102(impactSources114, q)))
        if (action === 'events') return output(await listPostgresRevisionEvents114(tx, parse102(impactEvents114, q)))
        return output(await previewPostgresImpacts114(tx, parse102(impactPreview114, q)))
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    }catch(error){const f=decisionFailure102(error);if(f.status===401)setHeader(event,'www-authenticate','Bearer realm="agent-api"');setResponseStatus(event,f.status);return f.body}
  })
}
