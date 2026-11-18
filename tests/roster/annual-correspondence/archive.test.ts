import { afterEach, expect, it } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { readAnnualWriteScope } from '../../../server/utils/annual-correspondence-read'
import { stageAnnualCorrespondence, activateAnnualCorrespondence, retryAnnualCorrespondence } from '../../../server/utils/jobs/annual-correspondence'
import { getJob } from '../../../layers/core/server/utils/job-store'
import { __resetJobRunner, clearJobSpecs, whenIdle, requestJobCancel } from '../../../layers/core/server/utils/job-runner'
import { listRecordCorrespondences, getRecordCorrespondenceAudit } from '../../../server/utils/record-correspondence'
import { schema } from '../../../db/client'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[]=[]
const fixture=()=>{__resetJobRunner();clearJobSpecs();const f=nativeCorrespondenceFixture();fixtures.push(f);return f}
afterEach(async()=>{await whenIdle();__resetJobRunner();clearJobSpecs();for(const f of fixtures.splice(0))f.close()})
it('stages native archive annual work atomically and runs the durable task once',async()=>{
 const f=fixture(),row=f.add(),receipt=stageAnnualCorrespondence(f.db,readAnnualWriteScope,{clientRequestId:'native-archive',eventIds:[f.event.id]})
 expect(getJob(f.db,receipt.jobId)?.state).toBe('queued');expect(listRecordCorrespondences(f.db)).toEqual([])
 activateAnnualCorrespondence(f.db,readAnnualWriteScope,[receipt.jobId],f.dir);await whenIdle()
 expect(getJob(f.db,receipt.jobId)).toMatchObject({state:'done',result:{events:[{status:'done',finalQualification:{status:'confirmed'}}]}})
 expect(listRecordCorrespondences(f.db)).toMatchObject([{relationId:row.id,status:'confirmed'}])
 const id=listRecordCorrespondences(f.db)[0]!.id,audit=getRecordCorrespondenceAudit(f.db,id)
 expect(stageAnnualCorrespondence(f.db,readAnnualWriteScope,{clientRequestId:'same-scope',eventIds:[f.event.id]}).jobId).toBe(receipt.jobId)
 expect(getRecordCorrespondenceAudit(f.db,id)).toEqual(audit)
})
it('rolls native task admission back with its enclosing archive transaction',()=>{
 const f=fixture();f.add()
 expect(()=>f.db.transaction(()=>{stageAnnualCorrespondence(f.db,readAnnualWriteScope,{clientRequestId:'rollback',eventIds:[f.event.id]});throw new Error('rollback')})).toThrow('rollback')
 expect(f.db.select().from(schema.job).all()).toEqual([]);expect(listRecordCorrespondences(f.db)).toEqual([])
})
it('resumes cancelled native work on the same durable task',async()=>{
 const f=fixture();f.add();const receipt=stageAnnualCorrespondence(f.db,readAnnualWriteScope,{clientRequestId:'cancel',eventIds:[f.event.id]})
 expect(requestJobCancel(f.db,receipt.jobId)).toMatchObject({state:'cancelled'})
 retryAnnualCorrespondence(f.db,readAnnualWriteScope,receipt.jobId,f.dir);await whenIdle()
 expect(getJob(f.db,receipt.jobId)?.state).toBe('done');expect(listRecordCorrespondences(f.db)).toHaveLength(1)
})
