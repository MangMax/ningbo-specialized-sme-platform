import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { comparePlatformComparison, type CandidateComparisonInput } from '../lib/roster/platform-comparison'

type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T
type Input = Mutable<CandidateComparisonInput>
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const U = '91330211255994457P', T = 'specialized_sme' as const
const bHash = 'b'.repeat(64), aHash = 'a'.repeat(64)
const stepId = '["[\\"business_list\\",10]"]'
function seal(i: Input): Input {
  i.legacy.titles = [{...i.legacy.titles[0]!, ...structuredClone(i.formal.assessment)}]
  const l = i.legacy
  l.snapshotId = hash(JSON.stringify([{ enterpriseId:l.enterpriseId, asOf:l.asOf, ruleVersion:l.ruleVersion, assessmentVersion:l.assessmentVersion },l.titles]))
  for (const p of i.processes) p.sourceGeneration = hash(JSON.stringify(p.sourceRefs))
  return i
}
function z(): Input {
  const event = { eventId:1, revision:1, eventType:'award', year:2024, batchSeq:1, decidedYear:null, reviewOutcome:null, evidenceIds:[101] }
  const assessment: Input['legacy']['titles'][number] = {
    titleCode:T, group:'eligible', cycles:[{originYear:2024,batchSeq:1,precision:'year'}],
    versions:{facts:'facts-v1',sources:'sources-v1',decisions:'decisions-v1',observations:'observations-v1'},
    officialQualification:{group:'eligible',message:'正式资格有效',basis:'event:1',notes:[]},
    subject:{status:'not_established',message:'未见终止',decisionIds:[]},region:{status:'not_established',message:'沿正式范围',decisionIds:[]},
    platform:{status:'requires_verification',comparison:'not_established',message:'未核对',truncated:false,observations:[]},
    correspondence:{status:'unmatched',message:'无对应',refs:[]},
    completeness:{status:'recorded',message:'有依据',gaps:[],eventIds:[],publishedNames:[{evidenceId:101,availability:'captured',nameKnown:true}]},
    evidence:[event],sourceVersions:[{evidenceId:101,eventId:1,sourceFile:'synthetic.pdf',storedFileId:91,sha256:aHash,bytes:10,removedAt:null,capturedRevision:1,capturedSha256:aHash}],
    references:['event:1'],notes:[],shadow:{legacyGroup:'eligible',difference:null},
  }
  const formal = Object.fromEntries(['titleCode','group','officialQualification','subject','region','cycles','versions','evidence','sourceVersions','completeness','correspondence'].map(k => [k,structuredClone(assessment[k as keyof typeof assessment])])) as Input['formal']['assessment']
  return seal({version:'platform-comparison-410-v1', titleCode:T,
    legacy:{enterpriseId:1,asOf:'2026-06-01T00:00:00Z',ruleVersion:'current-roster-116-v8',assessmentVersion:'enterprise-qualification-407-v1',snapshotId:'',titles:[assessment]},
    formal:{assessment:formal,cycles:[{cycle:{originYear:2024,batchSeq:1,precision:'year'},judgment:{anchor:{id:1,eventType:'award',year:2024,batchSeq:1,decidedYear:null,reviewOutcome:null},originYear:2024,batch:1,group:'eligible',awardEventIds:[1]},eventIds:[1]}]},
    queries:{truncated:false,sources:[{queryKey:U,source:{queryId:201,interface:'recognized_list',queriedAt:'2026-05-31T00:00:00Z',queryStatus:'no_record',status:'complete',titleCode:T,rdjb:'2',conditions:{uscc:U,combination:'and'},pages:[{source:'queryBusList',rdjb:'2',page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}],fullRange:true,completeness:'complete',unfinished:[],outcome:'no_record',subjectMatch:'exact_uscc'},
      metadata:{source:'queryBusList',status:'no_record',effectiveConditions:{uscc:U,combination:'and'},titleScope:{mode:'selected',rdjb:['2']},pages:[{source:'queryBusList',rdjb:'2',page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}],completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}}]},processes:[]})
}
function p(opposite = false): Input {
  const i=z(), q=i.queries.sources[0]!, rid=opposite?302:301, vid=opposite?12:11, did=opposite?402:401
  Object.assign(q.source,{queryId:202,interface:'business_list',queryStatus:'success',outcome:'records'})
  q.metadata!.source='businessList'; q.metadata!.status='success'
  for (const page of q.metadata!.pages) Object.assign(page,{source:'businessList',fetchedCount:1,declaredTotal:1})
  q.source.pages=structuredClone(q.metadata!.pages)
  const metadata = {recordId:10,versionId:vid,interface:'business_list',platformKey:'SQ-10',groupState:'verified',identityState:'resolved',contentState:'verified',keySource:'both',projectionRuleVersion:'1',hashAlgorithm:'sha256',contentHash:opposite?'c'.repeat(64):bHash} as const
  const decision = {id:did,relationId:rid,exportRowId:null,eventId:1,predecessorEventId:null,enterpriseId:1,titleCode:T,type:'event_process',role:'supports_award',status:'confirmed',revision:1,ruleId:'event-annual-process',ruleVersion:'1',createdAt:'2026-05-31T00:00:00Z',decidedAt:'2026-05-31T00:00:00Z',endedAt:null,requiresRevalidation:false} as const
  const observation = {relationId:rid,queryId:202,sequenceNo:1,interface:'business_list',relationKey:'SQ-10',queriedAt:q.source.queriedAt,queryStatus:'success',queryKey:U,rdjb:'2',queryTitleCode:T,titleCode:T,enterpriseId:1,usccRaw:U,nameRaw:'合成企业',verificationStatus:'confirmed',matchBasis:'uscc',target:{eventId:1,enterpriseId:1,titleCode:T,type:'event_process',role:'context_only'},evidence:{process:{eventType:'award',declareKind:'apply',appliedAt:'2024-03-01 09:00:00',status:opposite?'终审不通过':'终审通过',province:null,normalizationConflicts:[]},temporal:{relationYear:2024,relationBatch:null,awardBatchLabel:null},source:{identityOnly:false}},conflicts:[],businessRecord:metadata,existingCorrespondenceIds:[did],existingCorrespondences:[decision]}
  i.processes=[{input:{event:{id:1,eventType:'award',year:2024,decidedYear:null,reviewOutcome:null,record:{enterpriseId:1,titleCode:T,usccRaw:U}},groups:[{businessRecord:metadata,representativeRelationId:rid,observationRefs:[observation],existingCorrespondenceIds:[did],existingCorrespondences:[decision],conflicts:[]}],coverage:[{queryId:202,interface:'business_list',queriedAt:q.source.queriedAt,status:'success',completeness:'complete',fullRange:true}],scopeGaps:[]},
    sourceRefs:{scope:{enterpriseId:1,titleCode:T,businessYear:2024,declareKind:'apply',ruleVersion:'annual-process-250-v1'},event:{id:1,revision:1,recordId:81,eventType:'award',year:2024,decidedYear:null,reviewOutcome:null,usccRaw:U},evidence:[{id:101,sourceFile:'synthetic.pdf',attachment:null,listNo:1,page:1,fileId:91,sha256:aHash,removedAt:null}],titleScopeRefs:[{queryId:202,relationId:rid,titleCode:T,platformKey:'SQ-10',usccNorm:U,recordId:10,versionId:vid}],observations:[{queryId:202,relationId:rid,interface:'business_list',recordId:10,versionId:vid,sourceFingerprint:'d'.repeat(64)}],coverage:[{queryId:202,interface:'business_list',queriedAt:q.source.queriedAt,status:'success',completeness:'complete',fullRange:true}]},sourceGeneration:'',currentDecisionRefs:[decision],finalQualification:opposite?{stepId:null,status:'none',reasons:['official_result_mismatch'],decisionRefs:[]}:{stepId,status:'confirmed',reasons:[],decisionRefs:[decision]}}]
  return seal(i)
}
function states(i: Input, o: string, c: string, reason?: string) {
  const result=comparePlatformComparison(i)
  expect(result.observation.state).toBe(o);expect(result.comparison.state).toBe(c)
  if (reason) expect(result.comparison.cycles.flatMap(x=>x.reasons)).toContain(reason)
  return result
}
function fail(i: Input) { const q=i.queries.sources[0]!;q.source.queryStatus='failed';q.source.status='failed';q.source.outcome='unknown';q.metadata!.status='failed';q.metadata!.error={code:'upstream_failed',message:'SECRET_ERROR'};return i }
function recordsOnly(): Input {const i=p();i.processes=[];return i}
function queryAt(i: Input,time: string) {i.queries.sources[0]!.source.queriedAt=time;return i}
function freeze<T>(x:T):T {if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x}

function reviewInYear(i: Input, year: number): Input {
  const e=i.formal.assessment.evidence[0]!,b=i.formal.cycles[0]!,x=i.processes[0]!
  Object.assign(e,{eventType:'review',decidedYear:year,reviewOutcome:'passed'})
  Object.assign(b.judgment.anchor!,{eventType:'review',decidedYear:year,reviewOutcome:'passed'});b.judgment.awardEventIds=[]
  Object.assign(x.input.event,{eventType:'review',decidedYear:year,reviewOutcome:'passed'})
  Object.assign(x.sourceRefs.event,{eventType:'review',decidedYear:year,reviewOutcome:'passed'})
  Object.assign(x.sourceRefs.scope,{businessYear:year,declareKind:'review'})
  for(const g of x.input.groups)for(const o of g.observationRefs){o.evidence.process.eventType='review';o.evidence.process.declareKind='review';o.evidence.process.appliedAt=year+'-03-01 09:00:00';o.evidence.temporal.relationYear=year}
  for(const d of x.currentDecisionRefs)d.role='supports_review'
  if(x.finalQualification)for(const d of x.finalQualification.decisionRefs)d.role='supports_review'
  return seal(i)
}
function borrowedHistory(i: Input): Input {
  const x=i.processes[0]!,g=x.input.groups[0]!,current=g.observationRefs[0]!,old=structuredClone(current),q=structuredClone(i.queries.sources[0]!)
  Object.assign(old,{relationId:299,queryId:203,queriedAt:'2025-05-31T00:00:00Z',existingCorrespondenceIds:[],existingCorrespondences:[]})
  old.businessRecord.versionId=10;old.businessRecord.contentHash='e'.repeat(64)
  current.evidence.temporal.relationYear=null;current.evidence.process.appliedAt=null;g.observationRefs.push(old)
  Object.assign(q.source,{queryId:203,queriedAt:old.queriedAt});i.queries.sources.push(q)
  x.sourceRefs.observations.push({queryId:203,relationId:299,interface:'business_list',recordId:10,versionId:10,sourceFingerprint:'f'.repeat(64)})
  x.sourceRefs.titleScopeRefs.push({queryId:203,relationId:299,titleCode:T,platformKey:'SQ-10',usccNorm:U,recordId:10,versionId:10})
  const c={queryId:203,interface:'business_list',queriedAt:old.queriedAt,status:'success',completeness:'complete',fullRange:true}
  x.input.coverage.push(c);x.sourceRefs.coverage.push(structuredClone(c))
  return seal(i)
}
function nativeApplyCorroboration(i: Input): Input {
  const x=i.processes[0]!,o=structuredClone(x.input.groups[0]!.observationRefs[0]!),q=structuredClone(i.queries.sources[0]!)
  Object.assign(o,{relationId:304,queryId:204,interface:'apply_list',rdjb:'',queryTitleCode:null,existingCorrespondenceIds:[],existingCorrespondences:[]})
  Object.assign(o.businessRecord,{interface:'apply_list',recordId:30,versionId:31})
  Object.assign(q.source,{queryId:204,interface:'apply_list',titleCode:null,rdjb:''});q.metadata!.source='queryList';q.metadata!.titleScope={mode:'source_default',rdjb:[]}
  for(const page of [...q.source.pages,...q.metadata!.pages]){page.source='queryList';page.rdjb=null}
  i.queries.sources.push(q)
  x.input.groups.push({businessRecord:structuredClone(o.businessRecord),representativeRelationId:304,observationRefs:[o],existingCorrespondenceIds:[],existingCorrespondences:[],conflicts:[]})
  x.sourceRefs.observations.push({queryId:204,relationId:304,interface:'apply_list',recordId:30,versionId:31,sourceFingerprint:'e'.repeat(64)})
  x.sourceRefs.titleScopeRefs.push({queryId:204,relationId:304,titleCode:T,platformKey:'SQ-10',usccNorm:U,recordId:30,versionId:31})
  const c={queryId:204,interface:'apply_list',queriedAt:q.source.queriedAt,status:'success',completeness:'complete',fullRange:true}
  x.input.coverage.push(c);x.sourceRefs.coverage.push(structuredClone(c))
  if(x.finalQualification?.status==='confirmed')x.finalQualification.stepId='["[\\"apply_list\\",30]","[\\"business_list\\",10]"]'
  return seal(i)
}

describe('platform comparison 426',()=>{
  it('Z_unrestricted_zero',()=>{
    const i=z(),l=i.legacy
    expect(l.snapshotId).toBe(hash(JSON.stringify([{enterpriseId:1,asOf:l.asOf,ruleVersion:l.ruleVersion,assessmentVersion:l.assessmentVersion},l.titles])))
    expect(i.formal.cycles[0]!.judgment.anchor!.id).toBe(1)
    const r=states(i,'no_record','unsynchronized','no_record_in_applicable_scope')
    expect(r.comparison.cycles[0]!.refs.eventIds).toEqual([1]);expect(r.comparison.cycles[0]!.refs.queryIds).toEqual([201])
    expect(i.formal.assessment.group).toBe('eligible')
  })
  it('P_same_event_current',()=>{const r=states(p(),'records','synchronized','same_event_result_agrees');expect(r.comparison.cycles[0]!.refs.versions).toEqual([{recordId:10,versionId:11,contentHash:bHash}]);expect(r.comparison.cycles[0]!.refs.decisions).toEqual([{id:401,revision:1}])})
  it('N_same_event_opposite',()=>{const r=states(p(true),'records','unsynchronized','same_event_result_not_reflected');expect(r.comparison.cycles[0]!.refs.decisions).toEqual([{id:402,revision:1}])})
  it('unknown_terminal',()=>{const i=p();i.processes[0]!.input.groups[0]!.observationRefs[0]!.evidence.process.status='新状态';states(seal(i),'records','not_established','platform_status_unmapped')})
  it('confirmed_only',()=>states(recordsOnly(),'records','not_established','coverage_incomplete'))
  it('failed_only',()=>{const r=states(fail(z()),'query_failed','not_established','query_failed');expect(JSON.stringify(r)).not.toContain('SECRET_ERROR')})
  it('auth_failed_only',()=>{const i=fail(z());i.queries.sources[0]!.source.queryStatus='auth_failed';i.queries.sources[0]!.metadata!.status='auth_failed';states(i,'query_failed','not_established','query_failed')})
  it('no_queries',()=>{const i=z();i.queries.sources=[];states(i,'not_queried','not_established','not_queried')})
  it('explicit_notqueried',()=>{const i=z(),q=i.queries.sources[0]!;Object.assign(q.source,{queryStatus:'not_queried',status:'not_queried',outcome:'unknown',pages:[],fullRange:false,completeness:'not_queried'});Object.assign(q.metadata!,{status:'not_queried',pages:[],fullRange:false,completeness:'not_queried'});states(i,'not_queried','not_established','not_queried')})
  it('partial_only',()=>{const i=z(),q=i.queries.sources[0]!;q.source.status='partial';q.source.outcome='unknown';q.source.completeness='partial';q.metadata!.completeness='partial';states(i,'unknown','not_established','coverage_incomplete')})
  it('restricted_zero',()=>{const i=z(),q=i.queries.sources[0]!;Object.assign(q.metadata!.effectiveConditions,{whpcyear:'2026',whpc:'2026-1'});q.source.conditions=structuredClone(q.metadata!.effectiveConditions);q.source.outcome='unknown';states(i,'unknown','not_established','cycle_unresolved')})
  for(const kind of ['partial','failed'] as const) it('unrelated_'+kind,()=>{const i=z(),other=structuredClone((kind==='failed'?fail(z()):z()).queries.sources[0]!);other.source.queryId=203;other.metadata!.effectiveConditions={name:'合成企业',combination:'and'};other.source.conditions=structuredClone(other.metadata!.effectiveConditions);other.source.subjectMatch='name_only';other.queryKey='name:合成企业';other.source.outcome='unknown';if(kind==='partial'){other.source.status='partial';other.source.completeness='partial';other.metadata!.completeness='partial'}i.queries.sources.push(other);states(i,'no_record','unsynchronized','no_record_in_applicable_scope')})
  for(const future of [false,true]) it(future?'future_retry_failed':'later_retry_failed',()=>{const i=z(),other=structuredClone(fail(z()).queries.sources[0]!);other.source.queryId=203;other.source.queriedAt=future?'2026-06-02T00:00:00Z':'2026-05-31T01:00:00Z';i.queries.sources.push(other);states(i,future?'no_record':'query_failed',future?'unsynchronized':'not_established',future?'no_record_in_applicable_scope':'query_failed')})
  for(const [name,time,o,c,reason] of [
    ['future_only','2026-06-02T00:00:00Z','not_queried','not_established','observation_after_as_of'],
    ['at_asof','2026-06-01T00:00:00Z','no_record','unsynchronized','no_record_in_applicable_scope'],
    ['after_asof_millisecond','2026-06-01T00:00:00.001Z','not_queried','not_established','observation_after_as_of'],
    ['offset_same_instant','2026-06-01T08:00:00+08:00','no_record','unsynchronized','no_record_in_applicable_scope'],
    ['timezone_missing','2026-05-31T00:00:00','unknown','not_established','invalid_query_time'],
    ['invalid_calendar','2026-02-30T00:00:00Z','unknown','not_established','invalid_query_time'],
    ['invalid_hour','2026-05-31T24:00:00Z','unknown','not_established','invalid_query_time'],
    ['invalid_offset','2026-05-31T00:00:00+24:00','unknown','not_established','invalid_query_time'],
  ]) it(name!,()=>states(queryAt(z(),time!),o!,c!,reason))
  it('same_scope_same_time_conflict',()=>{const i=z(),q=structuredClone(p().queries.sources[0]!);q.source.interface='recognized_list';q.metadata!.source='queryBusList';q.source.pages.forEach(x=>x.source='queryBusList');q.metadata!.pages.forEach(x=>x.source='queryBusList');i.queries.sources.push(q);states(i,'unknown','not_established','source_conflict');i.queries.sources.reverse();states(i,'unknown','not_established','source_conflict')})
  it('other_source_real_conflict',()=>{const i=p();i.queries.sources.push(z().queries.sources[0]!);states(i,'unknown','not_established','source_conflict')})
  it('future_top50_truncated',()=>{const i=queryAt(z(),'2026-06-02T00:00:00Z');i.queries.truncated=true;states(i,'unknown','not_established','metadata_truncated')})
  it('success_with_truncation',()=>{const i=z();i.queries.truncated=true;const r=states(i,'unknown','not_established','metadata_truncated');expect(r.observation.sources[0]!.outcome).toBe('no_record')})
  it('cross_year_precision',()=>states(z(),'no_record','unsynchronized','no_record_in_applicable_scope'))
  it('same_year_order_unknown',()=>{const i=z(),e=i.formal.assessment.evidence[0]!,a=i.formal.cycles[0]!.judgment.anchor!;e.eventType=a.eventType='review';e.decidedYear=a.decidedYear=2026;e.reviewOutcome=a.reviewOutcome='passed';i.formal.cycles[0]!.judgment.awardEventIds=[];states(seal(i),'no_record','not_established','temporal_order_unresolved')})
  it('P_wrong_cycle',()=>{const i=p();i.processes[0]!.input.event.id=2;i.processes[0]!.sourceRefs.event.id=2;states(seal(i),'records','not_established','cycle_unresolved')})
  it('P_other_business_year',()=>{const i=p();i.processes[0]!.input.groups[0]!.observationRefs[0]!.evidence.temporal.relationYear=2025;states(seal(i),'records','not_established','cycle_unresolved')})
  it('P_other_title',()=>{const i=p();i.processes[0]!.input.event.record.titleCode='innovative_sme';states(seal(i),'records','not_established','cycle_unresolved')})
  it('P_stale_revision',()=>{const i=p();i.formal.assessment.evidence[0]!.revision=2;i.processes[0]!.currentDecisionRefs[0]!.requiresRevalidation=true;states(seal(i),'records','not_established','source_requires_revalidation')})
  it('P_stale_version',()=>{const i=p(),x=i.processes[0]!,g=x.input.groups[0]!;g.businessRecord.versionId=g.observationRefs[0]!.businessRecord.versionId=12;states(seal(i),'records','not_established','source_requires_revalidation')})
  it('P_withdrawn',()=>{const i=p();i.processes[0]!.currentDecisionRefs[0]!.status='unlinked';states(seal(i),'records','not_established','source_requires_revalidation')})
  it('P_not_indexed',()=>{const i=p(),g=i.processes[0]!.input.groups[0]!;g.businessRecord.groupState=g.observationRefs[0]!.businessRecord.groupState='not_indexed';states(seal(i),'records','not_established','source_requires_revalidation')})
  it('P_later_scope_gap',()=>{const i=p();i.processes[0]!.input.scopeGaps=[{relationId:399,queryId:202,interface:'business_list',year:null,declareKind:'apply',appliedAt:null,reasons:['title_scope_unknown']}];states(seal(i),'records','not_established','coverage_incomplete')})
  it('P_normalization_conflict',()=>{const i=p();i.processes[0]!.input.groups[0]!.observationRefs[0]!.conflicts=['status_conflict'];states(seal(i),'records','not_established','source_conflict')})
  it('recognized_row_only',()=>{const i=recordsOnly();i.queries.sources[0]!.source.interface='recognized_list';i.queries.sources[0]!.metadata!.source='queryBusList';for(const page of [...i.queries.sources[0]!.source.pages,...i.queries.sources[0]!.metadata!.pages])page.source='queryBusList';states(i,'records','not_established','cycle_unresolved')})
  it('no_formal_cycle',()=>{const i=recordsOnly();i.formal.cycles=[];i.formal.assessment.cycles=[];states(seal(i),'records','not_established')})
  it('formal_excluded_not_revived',()=>{const i=recordsOnly();i.formal.cycles=[];i.formal.assessment.cycles=[];i.formal.assessment.group=i.formal.assessment.officialQualification.group='excluded';states(seal(i),'records','not_established');expect(i.formal.assessment.group).toBe('excluded')})
  it('null_batch_preserved',()=>{const i=z();i.formal.assessment.cycles[0]!.batchSeq=null;i.formal.cycles[0]!.cycle.batchSeq=null;i.formal.cycles[0]!.judgment.batch=null;i.formal.cycles[0]!.judgment.anchor!.batchSeq=null;i.formal.assessment.evidence[0]!.batchSeq=null;const r=states(seal(i),'no_record','not_established','cycle_unresolved');expect(r.comparison.cycles[0]!.batchSeq).toBeNull()})
  for(const kind of ['agree','unknown','negative'] as const) it(kind==='agree'?'two_cycles_agree':kind==='unknown'?'one_cycle_unknown':'one_cycle_negative',()=>{
    const i=p(),second=p(kind==='negative'),binding=second.formal.cycles[0]!
    binding.cycle.batchSeq=2;binding.judgment.batch=2;binding.judgment.anchor!.id=2;binding.judgment.anchor!.batchSeq=2;binding.judgment.awardEventIds=[2];binding.eventIds=[2]
    const e=second.formal.assessment.evidence[0]!;e.eventId=2;e.batchSeq=2;e.evidenceIds=[102]
    const sv=second.formal.assessment.sourceVersions[0]!;sv.evidenceId=102;sv.eventId=2
    const x=second.processes[0]!,ob=x.input.groups[0]!.observationRefs[0]!,rid=kind==='negative'?312:311,did=kind==='negative'?412:411
    x.input.groups[0]!.businessRecord.recordId=20;x.input.groups[0]!.businessRecord.platformKey='SQ-20';ob.businessRecord.recordId=20;ob.businessRecord.platformKey='SQ-20';ob.relationKey='SQ-20';x.sourceRefs.observations[0]!.recordId=20;x.sourceRefs.titleScopeRefs[0]!.recordId=20;x.sourceRefs.titleScopeRefs[0]!.platformKey='SQ-20';if(x.finalQualification?.status==='confirmed')x.finalQualification.stepId=stepId.replace('10','20');
    x.input.event.id=2;x.sourceRefs.event.id=2;x.sourceRefs.evidence[0]!.id=102;x.sourceRefs.scope.businessYear=2024
    ob.relationId=rid;ob.target.eventId=2;ob.queryId=212
    x.input.groups[0]!.representativeRelationId=rid
    x.currentDecisionRefs[0]!.id=did;x.currentDecisionRefs[0]!.eventId=2;x.currentDecisionRefs[0]!.relationId=rid
    ob.existingCorrespondenceIds=[did];ob.existingCorrespondences=structuredClone(x.currentDecisionRefs)
    x.input.groups[0]!.existingCorrespondenceIds=[did];x.input.groups[0]!.existingCorrespondences=structuredClone(x.currentDecisionRefs)
    if(x.finalQualification?.status==='confirmed')x.finalQualification.decisionRefs=structuredClone(x.currentDecisionRefs)
    x.sourceRefs.titleScopeRefs[0]!.relationId=rid;x.sourceRefs.titleScopeRefs[0]!.queryId=212
    x.sourceRefs.observations[0]!.relationId=rid;x.sourceRefs.observations[0]!.queryId=212
    x.input.coverage[0]!.queryId=212;x.sourceRefs.coverage[0]!.queryId=212
    second.queries.sources[0]!.source.queryId=212
    i.formal.cycles.push(binding);i.formal.assessment.cycles.push(binding.cycle);i.formal.assessment.evidence.push(e);i.formal.assessment.sourceVersions.push(sv)
    i.queries.sources.push(second.queries.sources[0]!);if(kind!=='unknown')i.processes.push(x)
    const r=states(seal(i),'records',kind==='agree'?'synchronized':kind==='negative'?'unsynchronized':'not_established')
    expect(r.comparison.cycles.map(c=>c.state)).toEqual(['synchronized',kind==='agree'?'synchronized':kind==='negative'?'unsynchronized':'not_established'])
  })
  it('cycle_assignment_conflict',()=>{const i=p(),x=structuredClone(i.processes[0]!);x.input.event.id=999;i.processes.push(x);states(seal(i),'records','not_established','source_conflict')})
  it('legacy_none_inert',()=>{const r=states(z(),'no_record','unsynchronized');expect(r).not.toHaveProperty('difference_reason');expect(r).not.toHaveProperty('confirmed_no_diff')})
  it('immutable_input',()=>{const i=freeze(p()),before=JSON.stringify(i);states(i,'records','synchronized');expect(JSON.stringify(i)).toBe(before)})
  it('deterministic_repeat',()=>expect(comparePlatformComparison(p())).toEqual(comparePlatformComparison(p())))
  it('deterministic_order',()=>{const i=p(),j=p();i.processes[0]!.currentDecisionRefs.push({...i.processes[0]!.currentDecisionRefs[0]!,id:403});j.processes[0]!.currentDecisionRefs.push({...j.processes[0]!.currentDecisionRefs[0]!,id:403});j.processes[0]!.currentDecisionRefs.reverse();expect(comparePlatformComparison(seal(i))).toEqual(comparePlatformComparison(seal(j)))})
  for(const kind of ['revision','content','title','cycle','scope'] as const)it('digest_'+kind+'_sensitive',()=>{
    const i=p(),before=comparePlatformComparison(i),x=i.processes[0]!
    if(kind==='revision'){x.currentDecisionRefs[0]!.revision=2;x.finalQualification!.decisionRefs[0]!.revision=2}
    if(kind==='content'){x.input.groups[0]!.businessRecord.contentHash='e'.repeat(64);x.input.groups[0]!.observationRefs[0]!.businessRecord.contentHash='e'.repeat(64)}
    if(kind==='scope')i.legacy.asOf='2026-06-02T00:00:00Z'
    if(kind==='cycle'){i.formal.assessment.cycles[0]!.batchSeq=2;i.formal.cycles[0]!.cycle.batchSeq=2;i.formal.cycles[0]!.judgment.batch=2;i.formal.cycles[0]!.judgment.anchor!.batchSeq=2;i.formal.assessment.evidence[0]!.batchSeq=2}
    if(kind==='title'){
      const change=(v:any):void=>{if(v&&typeof v==='object')for(const k of Object.keys(v)){if(v[k]===T)v[k]='innovative_sme';else change(v[k])}}
      change(i);i.queries.sources[0]!.source.rdjb='1';i.queries.sources[0]!.metadata!.titleScope.rdjb=['1'];for(const page of [...i.queries.sources[0]!.source.pages,...i.queries.sources[0]!.metadata!.pages])page.rdjb='1';x.input.groups[0]!.observationRefs[0]!.rdjb='1'
    }
    const after=states(seal(i),'records','synchronized');expect(after.inputDigest).not.toBe(before.inputDigest);expect(after.resultDigest).not.toBe(before.resultDigest)
  })
  it('rejects_invalid_legacy_hash',()=>{const i=z();i.legacy.snapshotId='bad';expect(()=>comparePlatformComparison(i)).toThrow('invalid_legacy_snapshot')})
  it('rejects_overriding_assessment',()=>{const i=z();i.formal.assessment.group='excluded';expect(()=>comparePlatformComparison(i)).toThrow('invalid_selected_assessment')})
  it('rejects_foreign_cycle_join',()=>{const i=z();i.formal.cycles[0]!.eventIds=[999];expect(()=>comparePlatformComparison(i)).toThrow('invalid_cycle_join')})
  for(const bad of [undefined,NaN,Infinity,()=>1])it('rejects_non_json_'+String(bad),()=>{const i=z();(i as any).bad=bad;expect(()=>comparePlatformComparison(i)).toThrow('invalid_json_input')})
  it('rejects_unsorted_pages_as_proof',()=>{const i=z(),q=i.queries.sources[0]!;q.metadata!.pages[0]!.page=2;q.source.pages[0]!.page=2;states(i,'unknown','not_established','coverage_incomplete')})
  it('rejects_claimed_no_record_with_rows',()=>{const i=z();i.queries.sources[0]!.metadata!.pages[0]!.fetchedCount=1;states(i,'unknown','not_established','coverage_incomplete')})
  it('source_generation_mismatch',()=>{const i=p();i.processes[0]!.sourceGeneration='f'.repeat(64);states(i,'records','not_established','source_requires_revalidation')})
  it('current_candidate_without_confirmation',()=>{const i=p();i.processes[0]!.finalQualification={stepId,status:'eligible',reasons:['decision_required'],decisionRefs:[]};states(i,'records','not_established','source_requires_revalidation')})
  it('independent_digest_bytes_and_framing',()=>{
    // Independent test encoder: no production serializer or returned digest is used as an oracle.
    const encode=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(encode).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode(v[k])).join(',')+'}'
    expect(hash('["platform-comparison-410-v1",null,{}]')).toBe('48b3e2bd61d64a2f54bf29683a77f372a53afd88cf82eb3b29d75b300148dc3a')
    const i=z(),copy:any=structuredClone(i),l=i.legacy
    copy.legacy.titles[0].completeness.fieldGaps=null;copy.formal.assessment.completeness.fieldGaps=null
    copy.queries.sources[0].metadata.pages[0].maxPage=null;copy.queries.sources[0].source.pages[0].maxPage=null
    const scope={enterpriseId:1,titleCode:T,asOf:l.asOf,ruleVersion:l.ruleVersion,assessmentVersion:l.assessmentVersion,legacySnapshotId:l.snapshotId}
    const expectedInputDigest=hash(encode(['platform-comparison-410-v1',scope,copy]))
    const observation={state:'no_record',sources:[{queryId:201,queryStatus:'no_record',outcome:'no_record',applicability:'applicable',reasons:[]}]}
    const comparison={state:'unsynchronized',cycles:[{originYear:2024,batchSeq:1,state:'unsynchronized',reasons:['no_record_in_applicable_scope'],refs:{eventIds:[1],evidenceIds:[101],queryIds:[201],relationIds:[],events:[{id:1,revision:1}],sources:[{evidenceId:101,sha256:aHash}],versions:[],decisions:[],sourceGenerations:[]}}]}
    const r=comparePlatformComparison(i)
    expect(r.observation).toEqual(observation);expect(r.comparison).toEqual(comparison)
    expect(r.inputDigest).toBe(expectedInputDigest)
    expect(r.resultDigest).toBe(hash(encode([expectedInputDigest,observation,comparison])))
  })
  it('unknown_status_is_not_N_even_without_candidate',()=>{const i=p(true);i.processes[0]!.input.groups[0]!.observationRefs[0]!.evidence.process.status='已退回待审核';states(seal(i),'records','not_established','platform_status_unmapped')})
  it('missing_metadata_is_not_zero',()=>{const i=z();i.queries.sources[0]!.metadata=null;states(i,'unknown','not_established','coverage_incomplete')})
})


describe('PR429 R1 regression',()=>{
  it('S1_array_index_getter_is_rejected_without_execution',()=>{
    const i=z(),q=i.queries.sources[0]!;let calls=0
    Object.defineProperty(i.queries.sources,'0',{enumerable:true,configurable:true,get(){calls++;i.queries.truncated=true;return q}})
    expect(()=>comparePlatformComparison(i)).toThrow('invalid_json_input');expect(calls).toBe(0);expect(i.queries.truncated).toBe(false)
  })
  for(const opposite of [false,true])it(opposite?'F1_N_same_year_order_unknown':'F1_P_same_year_order_unknown',()=>states(reviewInYear(p(opposite),2026),'records','not_established','temporal_order_unresolved'))
  it('F1_observation_before_formal_year',()=>{const i=reviewInYear(p(true),2026),x=i.processes[0]!;i.queries.sources[0]!.source.queriedAt='2025-05-31T00:00:00Z';x.input.groups[0]!.observationRefs[0]!.queriedAt='2025-05-31T00:00:00Z';x.input.coverage[0]!.queriedAt=x.sourceRefs.coverage[0]!.queriedAt='2025-05-31T00:00:00Z';states(seal(i),'records','not_established','temporal_order_unresolved')})
  it('F2_foreign_history_cannot_supply_current_stable_fields',()=>{const i=borrowedHistory(p());i.processes[0]!.input.groups[0]!.observationRefs[1]!.target.eventId=2;states(seal(i),'records','not_established','cycle_unresolved')})
  it('F2_unbound_history_cannot_supply_current_stable_fields',()=>{const i=borrowedHistory(p()),x=i.processes[0]!;x.sourceRefs.observations=x.sourceRefs.observations.filter(r=>r.relationId!==299);x.sourceRefs.titleScopeRefs=x.sourceRefs.titleScopeRefs.filter(r=>r.relationId!==299);states(seal(i),'records','not_established','source_requires_revalidation')})
  it('F2_bound_history_is_included_without_requiring_old_confirmation',()=>{
    const i=borrowedHistory(p()),r=states(i,'records','synchronized','same_event_result_agrees'),refs=r.comparison.cycles[0]!.refs
    expect(refs.relationIds).toEqual([299,301]);expect(refs.queryIds).toEqual([202,203]);expect(refs.versions.map(v=>v.versionId).sort((a,b)=>a-b)).toEqual([10,11]);expect(refs.decisions).toEqual([{id:401,revision:1}])
  })
  it('F2_invalid_historical_version_cannot_supply_fields',()=>{const i=borrowedHistory(p());i.processes[0]!.input.groups[0]!.observationRefs[1]!.businessRecord.contentHash=null;states(seal(i),'records','not_established','source_requires_revalidation')})
  it('F3_native_apply_corroborates_title_bound_business',()=>{const i=nativeApplyCorroboration(p()),r=states(i,'records','synchronized','same_event_result_agrees');expect(r.comparison.cycles[0]!.refs.relationIds).toEqual([301,304]);expect(r.comparison.cycles[0]!.refs.queryIds).toEqual([202,204])})
  it('F3_native_apply_zero_is_not_single_title_absence',()=>{const i=z(),q=i.queries.sources[0]!;Object.assign(q.source,{interface:'apply_list',titleCode:null,rdjb:''});q.metadata!.source='queryList';q.metadata!.titleScope={mode:'source_default',rdjb:[]};for(const page of [...q.source.pages,...q.metadata!.pages]){page.source='queryList';page.rdjb=null}states(seal(i),'unknown','not_established','coverage_incomplete')})
  it('F3_apply_title_lineage_must_remain_bound',()=>{const i=nativeApplyCorroboration(p());i.processes[0]!.sourceRefs.titleScopeRefs=i.processes[0]!.sourceRefs.titleScopeRefs.filter(r=>r.relationId!==304);states(seal(i),'records','not_established','source_requires_revalidation')})
})


describe('PR429 R2 source binding',()=>{
  it('F2_query_interface_cannot_be_borrowed_from_directory',()=>{
    const i=borrowedHistory(p()),q=i.queries.sources.find(q=>q.source.queryId===203)!
    q.source.interface='recognized_list';q.metadata!.source='queryBusList';for(const page of [...q.source.pages,...q.metadata!.pages])page.source='queryBusList'
    states(seal(i),'records','not_established','coverage_incomplete')
  })
  it('F2_historical_record_interface_must_match_observation',()=>{const i=borrowedHistory(p());i.processes[0]!.input.groups[0]!.observationRefs[1]!.businessRecord.interface='apply_list';states(seal(i),'records','not_established','coverage_incomplete')})
  it('F2_annual_coverage_interface_must_match_query',()=>{const i=borrowedHistory(p()),x=i.processes[0]!;for(const coverage of [x.input.coverage,x.sourceRefs.coverage])coverage.find(c=>c.queryId===203)!.interface='recognized_list';states(seal(i),'records','not_established','coverage_incomplete')})
  it('F2_annual_coverage_time_must_match_query',()=>{const i=borrowedHistory(p()),x=i.processes[0]!;for(const coverage of [x.input.coverage,x.sourceRefs.coverage])coverage.find(c=>c.queryId===203)!.queriedAt='2025-04-01T00:00:00Z';states(seal(i),'records','not_established','coverage_incomplete')})
})


// #430: literal captured by #427's guarded SQLite case; no runtime file dependency.
// Snapshot/hash, null origin, source and authority fields are preserved verbatim.
function nullOrigin430(): Input {
  return JSON.parse(String.raw`
{
  "version": "platform-comparison-410-v1",
  "legacy": {
    "enterpriseId": 1,
    "asOf": "2026-06-01T00:00:00.000Z",
    "ruleVersion": "current-roster-116-v8",
    "assessmentVersion": "enterprise-qualification-407-v1",
    "snapshotId": "c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110",
    "titles": [
      {
        "titleCode": "little_giant",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      },
      {
        "titleCode": "specialized_sme",
        "group": "eligible",
        "cycles": [
          {
            "originYear": 2024,
            "batchSeq": 1,
            "precision": "year"
          }
        ],
        "versions": {
          "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
          "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "eligible",
          "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
          "basis": "event:1@1 award /1 结论年:2024",
          "notes": []
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [
            {
              "evidenceId": 1,
              "availability": "captured",
              "nameKnown": true
            }
          ],
          "eventIds": [],
          "fieldGaps": [
            {
              "eventId": 1,
              "field": "year",
              "valueState": "unknown",
              "inputState": "null"
            }
          ]
        },
        "evidence": [
          {
            "eventId": 1,
            "revision": 1,
            "eventType": "award",
            "year": null,
            "batchSeq": 1,
            "decidedYear": 2024,
            "reviewOutcome": null,
            "evidenceIds": [
              1
            ]
          }
        ],
        "sourceVersions": [
          {
            "evidenceId": 1,
            "eventId": 1,
            "sourceFile": "synthetic/null-year-427.pdf",
            "storedFileId": 1,
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 10,
            "removedAt": null,
            "capturedRevision": 1,
            "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ],
        "references": [
          "evidence:1 synthetic/null-year-427.pdf  序号:1"
        ],
        "notes": [],
        "shadow": {
          "legacyGroup": "eligible",
          "difference": null
        }
      },
      {
        "titleCode": "innovative_sme",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      }
    ]
  },
  "titleCode": "specialized_sme",
  "formal": {
    "assessment": {
      "titleCode": "specialized_sme",
      "group": "eligible",
      "officialQualification": {
        "group": "eligible",
        "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
        "basis": "event:1@1 award /1 结论年:2024",
        "notes": []
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "cycles": [
        {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        }
      ],
      "versions": {
        "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
        "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
      },
      "evidence": [
        {
          "eventId": 1,
          "revision": 1,
          "eventType": "award",
          "year": null,
          "batchSeq": 1,
          "decidedYear": 2024,
          "reviewOutcome": null,
          "evidenceIds": [
            1
          ]
        }
      ],
      "sourceVersions": [
        {
          "evidenceId": 1,
          "eventId": 1,
          "sourceFile": "synthetic/null-year-427.pdf",
          "storedFileId": 1,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bytes": 10,
          "removedAt": null,
          "capturedRevision": 1,
          "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ],
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [
          {
            "evidenceId": 1,
            "availability": "captured",
            "nameKnown": true
          }
        ],
        "eventIds": [],
        "fieldGaps": [
          {
            "eventId": 1,
            "field": "year",
            "valueState": "unknown",
            "inputState": "null"
          }
        ]
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      }
    },
    "cycles": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 1,
            "eventType": "award",
            "year": null,
            "decidedYear": 2024,
            "batchSeq": 1,
            "reviewOutcome": null,
            "revision": 1,
            "nameRaw": "合成427空原年",
            "usccRaw": "91330211255994457P",
            "source": "jxj"
          },
          "originYear": 2024,
          "batch": 1,
          "group": "eligible",
          "awardEventIds": [
            1
          ]
        },
        "eventIds": [
          1
        ]
      }
    ]
  },
  "queries": {
    "sources": [],
    "truncated": false
  },
  "processes": []
}
`)
}
describe('issue430 origin authority join', () => {
  it('real_null_origin_without_queries_preserves_legacy', () => {
    const i=nullOrigin430(), before=JSON.stringify(i), l=i.legacy
    expect(l.snapshotId).toBe('c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110')
    expect(hash(JSON.stringify([{enterpriseId:l.enterpriseId,asOf:l.asOf,ruleVersion:l.ruleVersion,assessmentVersion:l.assessmentVersion},l.titles]))).toBe('c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110')
    expect(i.formal.assessment.evidence[0]!.year).toBeNull()
    expect(i.queries).toEqual({sources:[],truncated:false})
    const r=comparePlatformComparison(i)
    expect(r.observation.state).toBe('not_queried')
    expect(r.comparison.state).toBe('not_established')
    expect(r.comparison.cycles[0]!.reasons).toEqual(['not_queried'])
    expect(i.formal.assessment.group).toBe('eligible')
    expect(JSON.stringify(i)).toBe(before)
  })
  it('award_null_origin_accepts_real_2024_cycle_preserves_hash_and_Z', () => {
    const i = nullOrigin430(), l = i.legacy
    expect(l.snapshotId).toBe('c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110')
    expect(hash(JSON.stringify([{enterpriseId:l.enterpriseId,asOf:l.asOf,ruleVersion:l.ruleVersion,assessmentVersion:l.assessmentVersion},l.titles]))).toBe('c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110')
    expect(i.formal.assessment.evidence[0]).toEqual({eventId:1,revision:1,eventType:'award',year:null,batchSeq:1,decidedYear:2024,reviewOutcome:null,evidenceIds:[1]})
    expect(i.formal.cycles[0]!.cycle).toEqual({originYear:2024,batchSeq:1,precision:'year'})
    expect(i.formal.cycles[0]!.judgment.anchor!.year).toBeNull()
    i.queries = z().queries // independently specified complete 2026 exact-USCC zero
    const before = JSON.stringify(i)
    const r = comparePlatformComparison(i)
    expect(r.observation.state).toBe('no_record')
    expect(r.comparison.state).toBe('unsynchronized')
    expect(r.comparison.cycles).toEqual([{originYear:2024,batchSeq:1,state:'unsynchronized',reasons:['no_record_in_applicable_scope'],refs:{eventIds:[1],evidenceIds:[1],queryIds:[201],relationIds:[],events:[{id:1,revision:1}],sources:[{evidenceId:1,sha256:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}],versions:[],decisions:[],sourceGenerations:[]}}])
    expect(i.formal.assessment.group).toBe('eligible')
    expect(i.formal.assessment.evidence[0]!.year).toBeNull()
    expect(i.formal.cycles[0]!.judgment.anchor!.year).toBeNull()
    expect(JSON.stringify(i)).toBe(before)
  })
  it('known_origin_wins_over_different_decided_year', () => {
    const i=z(), e=i.formal.assessment.evidence[0]!, a=i.formal.cycles[0]!.judgment.anchor!
    e.decidedYear=a.decidedYear=2025
    const r=comparePlatformComparison(seal(i))
    expect(r.comparison.cycles[0]!.originYear).toBe(2024)
    expect(r.comparison.state).toBe('unsynchronized')
    expect(e.year).toBe(2024); expect(e.decidedYear).toBe(2025)
  })
  it('review_null_origin_cannot_borrow_decided_year', () => {
    const i=z(), e=i.formal.assessment.evidence[0]!, a=i.formal.cycles[0]!.judgment.anchor!
    e.eventType=a.eventType='review'; e.year=a.year=null
    e.decidedYear=a.decidedYear=2024; e.reviewOutcome=a.reviewOutcome='passed'
    i.formal.cycles[0]!.judgment.awardEventIds=[]
    expect(()=>comparePlatformComparison(seal(i))).toThrow('invalid_cycle_event')
  })
  it('award_both_years_unknown_rejects', () => {
    const i=z(); i.formal.assessment.evidence[0]!.year=null; i.formal.cycles[0]!.judgment.anchor!.year=null
    expect(()=>comparePlatformComparison(seal(i))).toThrow('invalid_cycle_event')
  })
  it('award_null_origin_wrong_cycle_rejects', () => {
    const i=z(), e=i.formal.assessment.evidence[0]!, a=i.formal.cycles[0]!.judgment.anchor!
    e.year=a.year=null; e.decidedYear=a.decidedYear=2023
    expect(()=>comparePlatformComparison(seal(i))).toThrow('invalid_cycle_event')
  })
})
