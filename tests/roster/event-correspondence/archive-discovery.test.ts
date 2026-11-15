import { afterEach, expect, it } from 'vitest'

import { schema } from '../../../db/client'
import { nativeCorrespondenceFixture } from '../../helpers/native-correspondence-fixture'
import { listRecordCorrespondences } from '../../../server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

import { handleRecordCorrespondenceRequest } from '../../../server/utils/record-correspondence-api'
it('discovers native history without mutating observations or creating decisions', () => {
 const f=fixture(),old=f.add({status:'终审不通过'}),current=f.add(),before=f.db.select().from(schema.platformBusinessObservation).all()
 const result=handleRecordCorrespondenceRequest({action:'discover',method:'POST',body:{eventId:f.event.id}},{db:f.db})
 expect(result.status).toBe(200)
 expect(result.body).toMatchObject({total:2})
 const text=JSON.stringify(result.body)
 expect(text).toContain(String(old.id));expect(text).toContain(String(current.id));expect(text).not.toContain('PRIVATE-COOKIE')
 expect(f.db.select().from(schema.platformBusinessObservation).all()).toEqual(before)
 expect(listRecordCorrespondences(f.db)).toEqual([])
})
it('discovery excludes another title while retaining the matching native row', () => {
 const f=fixture();f.add();f.add({rdjb:'1',titleCode:'innovative_sme'})
 const result=handleRecordCorrespondenceRequest({action:'discover',method:'POST',body:{eventId:f.event.id}},{db:f.db})
 expect(result.status).toBe(200);expect(result.body).toMatchObject({total:1})
})
