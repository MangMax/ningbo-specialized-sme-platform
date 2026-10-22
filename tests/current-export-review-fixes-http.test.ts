import { matchesBusinessIdentity } from './helpers/current-export-118'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { currentExport118Fixture, rows, year } from '../tests/helpers/current-export-118'
const f = currentExport118Fixture()
beforeAll(() => f.start(), 90000)
afterAll(() => f.close())
it('较早未知周期失败不应覆盖后续明确新认定', async () => {
  const c = f.candidate('旧周期未知后重新认定', [
    {eventType:'award', year:year-6, batchSeq:1},
    {eventType:'review', year:null, decidedYear:year-3, reviewOutcome:'failed'},
    {eventType:'award', year, batchSeq:2},
  ])
  const {wb} = await f.workbook('review-unknown-cycle-then-award')
  const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.enterprise.id)).map(r => ({sheet:s.name,notes:r[11]})))
  console.log(JSON.stringify({case:'old-unknown-cycle',actual}))
  expect(actual.map(r => r.sheet)).toEqual(['有效企业'])
}, 60000)
it('已确认注销的同一主体不应因切换称号重新有效', async () => {
  const c = f.candidate('同主体注销跨称号')
  f.addRecord(c.enterprise.id,c.enterprise.name,[{eventType:'award',year}], 'innovative_sme')
  f.decision(c.enterprise.id,'deregistered',{titleCode:'innovative_sme'})
  const {wb} = await f.workbook('global-subject-deregistered')
  const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.enterprise.id)).map(r => ({sheet:s.name,notes:r[11]})))
  console.log(JSON.stringify({case:'cross-title-deregistered',actual}))
  expect(actual.map(r => r.sheet)).toEqual(['排除明细'])
}, 60000)
it('对应边引用读取不应展开无关原始平台大字段', async () => {
  const {schema:s} = await import('../db/client')
  const {preflightRecordCorrespondences,commitRecordCorrespondences} = await import('../server/utils/record-correspondence')
  const {readCurrentCandidate} = await import('../lib/roster/current-qualification')
  const c = f.candidate('轻量对应引用')
  const event = f.db.$client.prepare('select id from record_event where record_id=?').get(c.record.id) as {id:number}
  const query = f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-19',status:'success',rawResponse:'ARCHIVED_RAW_'+ 'x'.repeat(1024*1024)}).returning({id:s.platformQuery.id}).get()
  const relation = f.db.insert(s.platformRelation).values({queryId:query.id,sequenceNo:1,enterpriseId:c.enterprise.id,usccRaw:c.enterprise.usccNorm,verificationStatus:'confirmed',matchBasis:'uscc',rawFields:{archive:'ARCHIVED_RAW_'+ 'x'.repeat(1024*1024)},sourceText:'ARCHIVED_RAW_'+ 'x'.repeat(1024*1024)}).returning({id:s.platformRelation.id}).get()
  const request:any = {idempotencyKey:'review-raw-edge',sourceIdentity:'synthetic',actor:{type:'user',id:'reviewer'},basis:'explicit confirmation',ruleId:'manual',ruleVersion:'1',operations:[{action:'create',edge:{type:'event_process',eventId:event.id,relationId:relation.id,role:'context_only'},status:'confirmed'}]}
  const plan = preflightRecordCorrespondences(f.db,request)
  const edge = commitRecordCorrespondences(f.db,request,plan.planHash)
  let rawBytes = 0
  const prepare = f.db.$client.prepare.bind(f.db.$client)
  f.db.$client.prepare = ((sql:string) => {
    const st = prepare(sql)
    const count = (x:any):void => { if (typeof x === 'string' && x.includes('ARCHIVED_RAW_')) rawBytes += Buffer.byteLength(x); else if (x && typeof x === 'object') Object.values(x).forEach(count) }
    for (const method of ['all','get'] as const) { const run = st[method].bind(st); Object.assign(st,{[method]:(...p:any[]) => {const result = run(...p);count(result);return result}}) }
    return st
  }) as any
  try {
    const row = readCurrentCandidate(f.db.$client,c.enterprise.id,'specialized_sme',year)
    console.log(JSON.stringify({case:'raw-materialization',rawBytes,group:row.group,edge:edge.correspondenceIds}))
    expect(row.group).toBe('eligible')
    const ref = 'correspondence:' + edge.correspondenceIds[0]
    const reference = () => readCurrentCandidate(f.db.$client,c.enterprise.id,'specialized_sme',year).references.find(r => r.startsWith(ref))!
    expect(reference()).not.toContain('来源需重新核实')
    // Same-length archive edits must be detected, not just byte-count changes.
    prepare('update platform_query set raw_response=? where id=?').run('ARCHIVED_RAW_'+ 'x'.repeat(1024*1024-1)+'y',query.id)
    expect(reference()).toContain('来源需重新核实')
    prepare('update platform_query set raw_response=? where id=?').run('ARCHIVED_RAW_'+ 'x'.repeat(1024*1024),query.id)
    expect(reference()).not.toContain('来源需重新核实')
    prepare('update platform_relation set source_text=? where id=?').run('ARCHIVED_RAW_'+ 'x'.repeat(1024*1024-1)+'z',relation.id)
    expect(reference()).toContain('来源需重新核实')
    prepare('update platform_relation set source_text=? where id=?').run('ARCHIVED_RAW_'+ 'x'.repeat(1024*1024),relation.id)
    expect(reference()).not.toContain('来源需重新核实')
    prepare('update record_event set revision=revision+1 where id=?').run(event.id)
    expect(reference()).toContain('来源需重新核实')
    expect(rawBytes).toBe(0)
    const {wb} = await f.workbook('large-refs-http')
    const exported = rows(wb,'有效企业').find(r => matchesBusinessIdentity(f.db, r, c.enterprise.id))!
    expect(exported[12]).toContain('工信部企业信息查询')
    expect(exported[11]).toContain('对应关系的来源需重新核实')
    expect(exported.join(' ')).not.toContain(ref)
    console.log(JSON.stringify({case:'bounded-ref-change-detection',archivedBytes:1024*1024,driverRawBytes:rawBytes}))
  } finally { f.db.$client.prepare = prepare }
}, 60000)

it('公开能力发现只列实际已部署专用POST且不创建任务', async () => {
  const before = await f.json(await fetch(f.url('/api/jobs?kind=current-roster-export')))
  const response = await fetch(f.url('/api/roster/exports/current/capabilities'))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const capability = await response.json()
  expect(capability).toEqual({ exports: [
    {titleCode:'little_giant',path:'/api/roster/exports/current/little-giant',ready:true},
    {titleCode:'specialized_sme',path:'/api/roster/exports/current/specialized-sme',ready:true},
    {titleCode:'innovative_sme',path:'/api/roster/exports/current/innovative-sme',ready:true},
  ] })
  const after = await f.json(await fetch(f.url('/api/jobs?kind=current-roster-export')))
  expect(after.total).toBe(before.total)
},60000)

it('未知原周期仅在明确早于新认定时让位而保留同年未来及缺时序冲突', async () => {
  const cases = [
    {name:'早于恢复',decidedYear:year-1,sheet:'有效企业'},
    {name:'同年恢复',decidedYear:year,sheet:'待确认'},
    {name:'未来结论',decidedYear:year+1,sheet:'待确认'},
    {name:'未知结论年',decidedYear:null,sheet:'待确认'},
  ]
  const entries = cases.map(c => ({...c,...f.candidate(c.name,[{eventType:'review',year:null,decidedYear:c.decidedYear,reviewOutcome:'failed'},{eventType:'award',year,batchSeq:2}])}))
  const {wb} = await f.workbook('unknown-cycle-boundaries')
  for (const c of entries) {
    const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.enterprise.id)).map(r => ({sheet:s.name,row:r})))
    expect(actual.map(r => r.sheet)).toEqual([c.sheet])
    expect(actual[0]!.row[7]).toContain('复核未通过')
    expect(actual[0]!.row[12] ?? '').not.toContain('decision:')
    expect(actual[0]!.row[11]).toContain('周期未知')
  }
},60000)

it('仅正式复核延续仍要求日期周期批次身份并处理后续失败与冲突', async () => {
  const passed = {eventType:'review',year:year-4,decidedYear:year-1,reviewOutcome:'passed',batchSeq:1} as const
  const cases: Array<{name:string;events: import('./helpers/current-export-118').Event[];sheet:string;badIdentity?:boolean}> = [
    {name:'仅正式延续',events:[passed],sheet:'有效企业'},
    {name:'延续到期',events:[{...passed,decidedYear:year-3}],sheet:'待确认'},
    {name:'延续无结论年',events:[{...passed,decidedYear:null}],sheet:'待确认'},
    {name:'延续无原周期',events:[{...passed,year:null}],sheet:'待确认'},
    {name:'延续无批次',events:[{...passed,batchSeq:null}],sheet:'待确认'},
    {name:'延续身份冲突',events:[passed],sheet:'待确认',badIdentity:true},
    {name:'延续后本周期失败',events:[passed,{...passed,decidedYear:year,reviewOutcome:'failed'}],sheet:'排除明细'},
    {name:'延续同年失败冲突',events:[passed,{...passed,reviewOutcome:'failed'}],sheet:'待确认'},
    {name:'延续未来失败',events:[passed,{...passed,decidedYear:year+1,reviewOutcome:'failed'}],sheet:'待确认'},
  ]
  const entries = cases.map(c => ({...c,...f.candidate(c.name,c.events)}))
  for (const c of entries.filter(c => c.badIdentity)) f.db.$client.prepare('update record set uscc_raw=? where id=?').run('OTHER-IDENTITY',c.record.id)
  const {wb} = await f.workbook('formal-renewal-boundaries')
  for (const c of entries) {
    const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.enterprise.id)).map(r => ({sheet:s.name,row:r})))
    expect(actual.map(r => r.sheet),c.name).toEqual([c.sheet])
    expect(actual[0]!.row[6] ?? null).toBeNull()
    expect(actual[0]!.row[12]).toContain('synthetic-118.xlsx')
  }
},60000)

it('跨称号主体事实遵守当前替代撤回生效身份及迁回而不传播资格解释', async () => {
  const entries: Array<{id:number;sheet:string;decisionId:number;reason:string;title:string}> = []
  for (const reason of ['moved_out','deregistered'] as const) {
    const c = f.candidate('跨称号主体' + reason), d = f.decision(c.enterprise.id,reason,{titleCode:'innovative_sme'})
    entries.push({id:c.enterprise.id,sheet:'排除明细',decisionId:d.id,reason,title:'innovative_sme'})
  }
  for (const [label,extra] of [
    ['无主体依据',{basis:null}],['未确认主体事实',{verificationStatus:'pending'}],['旧导入主体',{lifecycleAction:null}],['未来主体事实',{effectiveAt:'2200-01-01T00:00:00Z'}],
  ] as const) {
    const c = f.candidate(label), d = f.decision(c.enterprise.id,'moved_out',{titleCode:'innovative_sme',...extra})
    entries.push({id:c.enterprise.id,sheet:'待确认',decisionId:d.id,reason:'moved_out',title:'innovative_sme'})
  }
  for (const action of ['withdraw','replace'] as const) {
    const c = f.candidate('跨称号当前' + action)
    const old = f.decision(c.enterprise.id,'moved_out',{titleCode:'innovative_sme',recordedAt:'2025-01-01T00:00:00Z'})
    const d = f.decision(c.enterprise.id,'moved_in',{titleCode:'innovative_sme',lifecycleAction:action,previousId:old.id,movedInTitleCode:'innovative_sme',effectiveAt:'2026-01-01T00:00:00Z'})
    entries.push({id:c.enterprise.id,sheet:'有效企业',decisionId:d.id,reason:'moved_in',title:'innovative_sme'})
  }
  const conflict = f.candidate('跨称号同生效冲突')
  f.decision(conflict.enterprise.id,'moved_out',{titleCode:'innovative_sme'})
  const d = f.decision(conflict.enterprise.id,'moved_in',{titleCode:'little_giant',movedInTitleCode:'little_giant'})
  entries.push({id:conflict.enterprise.id,sheet:'待确认',decisionId:d.id,reason:'moved_in',title:'little_giant'})
  const unrelated = f.candidate('别称号资格解释不传播')
  f.decision(unrelated.enterprise.id,'other',{titleCode:'innovative_sme',reasonNote:'该称号资格终止'})
  const {wb} = await f.workbook('subject-scope-boundaries')
  for (const c of entries) {
    const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.id)).map(r => ({sheet:s.name,row:r})))
    expect(actual.map(r => r.sheet)).toEqual([c.sheet])
    expect(actual[0]!.row[12]).toContain('synthetic-118.xlsx')
    expect(f.db.$client.prepare('select enterprise_id,reason_code,title_code from difference_reason where id=?').get(c.decisionId)).toEqual({enterprise_id:c.id,reason_code:c.reason,title_code:c.title})
    expect(actual[0]!.row.join(' ')).not.toContain('decision:' + c.decisionId)
    if (c.sheet === '有效企业') expect(actual[0]!.row[11] ?? '').not.toContain('不属于本称号')
  }
  expect(rows(wb,'有效企业').some(r => matchesBusinessIdentity(f.db, r, unrelated.enterprise.id))).toBe(true)
},60000)

it('旧认定与独立正式复核按周期组合并保留历史及失败冲突边界', async () => {
  const old = {eventType:'award',year:year-8,batchSeq:1} as const
  const renewal = {eventType:'review',year:year-4,decidedYear:year-1,reviewOutcome:'passed',batchSeq:1} as const
  const cases: Array<{name:string;events: import('./helpers/current-export-118').Event[];sheet:string}> = [
    {name:'旧认定加新周期正式延续',events:[old,renewal],sheet:'有效企业'},
    {name:'独立延续后本周期失败',events:[old,renewal,{...renewal,decidedYear:year,reviewOutcome:'failed'}],sheet:'排除明细'},
    {name:'独立延续同年冲突',events:[old,renewal,{...renewal,reviewOutcome:'failed'}],sheet:'待确认'},
    {name:'未知周期失败不能借旧认定让位给复核',events:[old,{eventType:'review',year:null,decidedYear:year-2,reviewOutcome:'failed'},renewal],sheet:'待确认'},
    {name:'独立延续缺批次',events:[old,{...renewal,batchSeq:null}],sheet:'待确认'},
    {name:'独立延续批次不明失败',events:[old,renewal,{...renewal,batchSeq:null,decidedYear:year,reviewOutcome:'failed'}],sheet:'待确认'},
    {name:'旧周期晚通过不能掩盖新周期失败',events:[old,renewal,{eventType:'award',year:year-2,batchSeq:2},{eventType:'review',year:year-2,batchSeq:2,decidedYear:year,reviewOutcome:'failed'}],sheet:'排除明细'},
    {name:'旧周期失败不终止独立延续',events:[old,{eventType:'review',year:old.year,batchSeq:1,decidedYear:year,reviewOutcome:'failed'},renewal],sheet:'有效企业'},
    {name:'失败后新认定恢复',events:[old,renewal,{...renewal,decidedYear:year-1,reviewOutcome:'failed'},{eventType:'award',year,batchSeq:2}],sheet:'有效企业'},
  ]
  const entries = cases.map(c => ({...c,...f.candidate(c.name,c.events)}))
  const {wb} = await f.workbook('mixed-cycle-r2')
  for (const c of entries) {
    const actual = wb.worksheets.slice(0,3).flatMap(s => rows(wb,s.name).filter(r => matchesBusinessIdentity(f.db, r, c.enterprise.id)).map(r => ({sheet:s.name,row:r})))
    expect.soft(actual.map(r => r.sheet),c.name).toEqual([c.sheet])
    expect(actual[0]!.row[6]).toBe(String(year-8))
    expect(actual[0]!.row[7]).toContain(String(year-8))
    expect(actual[0]!.row[7]).toContain('复核通过')
    expect(actual[0]!.row[12]).toContain('synthetic-118.xlsx')
  }
},60000)

it('注销与地理事实独立核验且仅明确撤回替代恢复主体', async () => {
  const entries: Array<{id:number;sheet:string;refs:number[];note?:string}> = []
  const add = (name:string) => f.candidate(name).enterprise
  for (const [label,inboundTime] of [['随后迁入','2026-01-01T00:00:00Z'],['同时迁入','2025-01-01T00:00:00Z'],['早先迁入','2024-01-01T00:00:00Z']] as const) {
    const e=add('注销加独立'+label)
    const terminated=f.decision(e.id,'deregistered',{titleCode:'innovative_sme',recordedAt:'2025-01-01T00:00:00Z'})
    const inbound=f.decision(e.id,'moved_in',{titleCode:'little_giant',effectiveAt:inboundTime,movedInTitleCode:'little_giant'})
    entries.push({id:e.id,sheet:'排除明细',refs:[terminated.id,inbound.id],note:'注销/主体终止'})
  }
  for (const action of ['withdraw','replace'] as const) {
    const e=add('注销被明确'+action)
    const terminated=f.decision(e.id,'deregistered',{titleCode:'innovative_sme',recordedAt:'2025-01-01T00:00:00Z'})
    const corrected=f.decision(e.id,'moved_in',{titleCode:'innovative_sme',previousId:terminated.id,lifecycleAction:action,effectiveAt:'2026-01-01T00:00:00Z'})
    entries.push({id:e.id,sheet:'有效企业',refs:[corrected.id]})
  }
  const e=add('迁出后独立迁回不串称号')
  const out=f.decision(e.id,'moved_out',{titleCode:'innovative_sme'})
  const returned=f.decision(e.id,'moved_in',{titleCode:'little_giant',effectiveAt:'2026-01-01T00:00:00Z',movedInTitleCode:'little_giant'})
  entries.push({id:e.id,sheet:'有效企业',refs:[out.id,returned.id],note:'迁入宁波'})
  const unknown=add('注销适用性待核后迁入')
  const ud=f.decision(unknown.id,'deregistered',{titleCode:'innovative_sme',basis:null})
  const ui=f.decision(unknown.id,'moved_in',{titleCode:'little_giant',effectiveAt:'2026-01-01T00:00:00Z'})
  entries.push({id:unknown.id,sheet:'待确认',refs:[ud.id,ui.id],note:'适用性未确认'})
  const gap=f.candidate('只有别称号迁入不造当前资格',[])
  const gi=f.decision(gap.enterprise.id,'moved_in',{titleCode:'little_giant',effectiveAt:'2026-01-01T00:00:00Z',movedInTitleCode:'little_giant'})
  entries.push({id:gap.enterprise.id,sheet:'待确认',refs:[gi.id],note:'不能代替资格依据'})
  const {wb}=await f.workbook('subject-dimensions-r2')
  for (const c of entries) {
    const actual=wb.worksheets.slice(0,3).flatMap(s=>rows(wb,s.name).filter(r=>matchesBusinessIdentity(f.db, r, c.id)).map(r=>({sheet:s.name,row:r})))
    expect(actual.map(r=>r.sheet),String(c.id)).toEqual([c.sheet])
    for (const id of c.refs) {
      expect(f.db.$client.prepare('select enterprise_id from difference_reason where id=?').get(id)).toEqual({enterprise_id:c.id})
      expect(actual[0]!.row.join(' ')).not.toContain('decision:'+id)
    }
    if (c.id !== gap.enterprise.id) expect(actual[0]!.row[12]).toContain('synthetic-118.xlsx')
    if (c.note) expect(actual[0]!.row[11]).toContain(c.note)
    if (c.sheet==='有效企业') expect(actual[0]!.row[11]??'').not.toContain('不属于本称号')
  }
},60000)
