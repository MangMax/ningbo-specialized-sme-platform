import { getHeader, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { useDb } from '@db'
import { readApiToken, resolveApiAuth } from './api-auth'
import { DecisionError102, parse102 } from './decision-lifecycle-102'
import { decisionOutput102, decisionFailure102 } from './decision-lifecycle-102-output'
import { impactList114, impactGet114, impactSources114, impactEvents114, impactPreview114, workCommand114, listImpacts114, getImpact114, listSources114, listEvents114, previewImpacts114, work114 } from './evidence-review-114'
export function reviewRoute114(action:'list'|'get'|'sources'|'events'|'preview'|'commands') {
  return defineEventHandler(async(event:H3Event)=>{
    setHeader(event,'cache-control','no-store')
    try{
      const db=useDb(), output=decisionOutput102(db)
      if(action==='commands'){
        if(!resolveApiAuth({given:readApiToken({authorization:getHeader(event,'authorization'),'x-api-token':getHeader(event,'x-api-token')}),configured:useRuntimeConfig().apiToken}).writeAuthorized)throw new DecisionError102(401,'unauthorized','Configured API token required')
        let body:unknown;try{body=await readBody(event)}catch{throw new DecisionError102(400,'invalid_request','Malformed JSON request body')}
        return output(work114(db,parse102(workCommand114,body)))
      }
      const raw={...getQuery(event),...(getRouterParam(event,'id')?{id:getRouterParam(event,'id')}:{}),...(getRouterParam(event,'revisionId')?{revisionId:getRouterParam(event,'revisionId')}:{})}
      const q=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,['enterpriseId','decisionId','eventId','revisionId','id','limit'].includes(k)&&typeof v==='string'&&/^\d+$/.test(v)?Number(v):v]))
      return db.transaction(tx=>{
        if(action==='get')return output(getImpact114(db,parse102(impactGet114,q).id))
        if(action==='sources')return output(listSources114(db,parse102(impactSources114,q)))
        if(action==='events')return output(listEvents114(db,parse102(impactEvents114,q)))
        if(action==='preview')return output(previewImpacts114(db,parse102(impactPreview114,q)))
        return output(listImpacts114(db,parse102(impactList114,q)))
      })
    }catch(error){const f=decisionFailure102(error);if(f.status===401)setHeader(event,'www-authenticate','Bearer realm="agent-api"');setResponseStatus(event,f.status);return f.body}
  })
}
