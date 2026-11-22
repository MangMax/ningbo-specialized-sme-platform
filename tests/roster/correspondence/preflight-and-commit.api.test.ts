import { expect, it } from 'vitest'


import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
const createDb = useIsolatedPostgresCases()
const fixture = () => nativeCorrespondenceFixture(createDb())

import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
it('native REST writes require authorization and return sanitized source detail', async () => {
 const f=await fixture(),row=await f.add(),body=f.request('api',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])
 expect((await handlePostgresCorrespondenceRequest({action:'preflight',method:'POST',body},'private')).status).toBe(401)
 expect(await listPostgresCorrespondences(f.db,{})).toEqual([])
 const plan=await handlePostgresCorrespondenceRequest({action:'preflight',method:'POST',body,headers:{authorization:'Bearer private'}},'private')
 expect(plan.status).toBe(200)
 const committed=await handlePostgresCorrespondenceRequest({action:'commit',method:'POST',body:{request:body,planHash:(plan.body as {planHash:string}).planHash},headers:{authorization:'Bearer private'}},'private')
 expect(committed.status).toBe(200)
 const id=(await listPostgresCorrespondences(f.db,{}))[0]!.id
 const detail=await handlePostgresCorrespondenceRequest({action:'get',method:'GET',id})
 expect(detail.status).toBe(200);expect(detail.headers['cache-control']).toBe('no-store')
 expect(JSON.stringify(detail.body)).not.toContain('PRIVATE-COOKIE')
 expect((await readPostgresCorrespondenceRefs(f.db,[id]))[0]).toMatchObject({relationId:row.id,status:'confirmed',requiresRevalidation:false})
})
it('native REST and MCP list reads share a read-only decision result', async () => {
 const f=await fixture(),row=await f.add();await f.save(f.request('read',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))
 const before=(await f.db.$client.query("SELECT count(*) AS count FROM business.record_correspondence_audit")).rows
 const rest=await handlePostgresCorrespondenceRequest({action:'list',method:'GET',query:{eventId:String(f.event.id)}})
 const wire=await dispatchRecordCorrespondenceMcp('list',{eventId:f.event.id})
 expect(rest.status).toBe(200);expect(wire).toEqual(rest.body)
 expect((await f.db.$client.query("SELECT count(*) AS count FROM business.record_correspondence_audit")).rows).toEqual(before)
})
