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
