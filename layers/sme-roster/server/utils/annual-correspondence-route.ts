import { createError, defineEventHandler, getHeader, getMethod, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { z } from 'zod'
import { requestLogContext } from '../../../core/lib/logging'
import { checkBrowserReviewRequest } from '../../../../server/utils/browser-review-102'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { handleAnnualTaskRequest, type AnnualTaskAction, type AnnualTaskContext } from './annual-correspondence-api'

/** The context supplies the shared reader. Browser calls carry no token; exact
 * same-origin capability is checked before body parsing or database access. */
export function annualTaskRoute(action: AnnualTaskAction, context: () => Omit<AnnualTaskContext,'apiToken'|'browserAuthorized'> & {config:{apiToken?:string}}, options: {eventScoped?:boolean} = {}) {
  return defineEventHandler(async (event: H3Event) => {
    setHeader(event,'cache-control','no-store')
    const runtime = context(), config = runtime.config
    const headers = {authorization:getHeader(event,'authorization'),'x-api-token':getHeader(event,'x-api-token')}
    const token = readApiToken(headers)
    const apiAuthorized = resolveApiAuth({given:token,configured:config.apiToken}).writeAuthorized
    let browserAuthorized = false
    if (getMethod(event) !== 'GET' && !apiAuthorized && !token) {
      const gate = checkBrowserReviewRequest(event,{write:true})
      if (!gate.ok) {setResponseStatus(event,gate.status);return {error:{code:gate.code}}}
      browserAuthorized = true
    }
    let body:unknown
    if (getMethod(event) === 'POST') {
      try {body=await readBody(event)} catch {throw createError({statusCode:400,message:'invalid_json'})}
    }
    if (options.eventScoped) {
      const parsed = z.strictObject({clientRequestId:z.string().trim().min(1).max(120)}).safeParse(body)
      const value = getRouterParam(event,'id')
      const id = value && /^\d+$/.test(value) ? Number(value) : NaN
      if (!parsed.success || !Number.isSafeInteger(id) || id <= 0) {setResponseStatus(event,400);return {error:{code:'invalid_annual_task_request'}}}
      body={clientRequestId:parsed.data.clientRequestId,eventIds:[id]}
    }
    const output = await handleAnnualTaskRequest(action,{method:getMethod(event),headers,body,id:getRouterParam(event,'id')},{
      get db(){return runtime.db},readScope:runtime.readScope,filesDir:runtime.filesDir,apiToken:config.apiToken,
      browserAuthorized:browserAuthorized || action === 'detail',
      logContext: requestLogContext(event),
    })
    setResponseStatus(event,output.status)
    for(const [key,value] of Object.entries(output.headers))setHeader(event,key,value)
    return output.body
  })
}
