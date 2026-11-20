import { afterEach, expect, it } from 'vitest'


import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { getRecordCorrespondence, listRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

import { handleRecordCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
it('native REST writes require authorization and return sanitized source detail', () => {
 const f=fixture(),row=f.add(),body=f.request('api',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])
 expect(handleRecordCorrespondenceRequest({action:'preflight',method:'POST',body},{db:f.db,apiToken:'private'}).status).toBe(401)
 expect(listRecordCorrespondences(f.db)).toEqual([])
 const plan=handleRecordCorrespondenceRequest({action:'preflight',method:'POST',body,headers:{authorization:'Bearer private'}},{db:f.db,apiToken:'private'})
 expect(plan.status).toBe(200)
 const committed=handleRecordCorrespondenceRequest({action:'commit',method:'POST',body:{request:body,planHash:(plan.body as {planHash:string}).planHash},headers:{authorization:'Bearer private'}},{db:f.db,apiToken:'private'})
 expect(committed.status).toBe(200)
 const id=listRecordCorrespondences(f.db)[0]!.id
 const detail=handleRecordCorrespondenceRequest({action:'get',method:'GET',id},{db:f.db})
 expect(detail.status).toBe(200);expect(detail.headers['cache-control']).toBe('no-store')
 expect(JSON.stringify(detail.body)).not.toContain('PRIVATE-COOKIE')
 expect(getRecordCorrespondence(f.db,id)).toMatchObject({relationId:row.id,status:'confirmed',requiresRevalidation:false})
})
it('native REST and MCP list reads share a read-only decision result', async () => {
 const f=fixture(),row=f.add();f.save(f.request('read',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))
 const before=f.db.$client.prepare('select total_changes() n').get()
 const rest=handleRecordCorrespondenceRequest({action:'list',method:'GET',query:{eventId:String(f.event.id)}},{db:f.db})
 const wire=await dispatchRecordCorrespondenceMcp('list',{eventId:f.event.id},{db:f.db})
 expect(rest.status).toBe(200);expect(wire).toEqual(rest.body)
 expect(f.db.$client.prepare('select total_changes() n').get()).toEqual(before)
})
