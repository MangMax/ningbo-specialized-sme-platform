import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, rows, year as y } from './helpers/current-export-118'
import { qualificationCasesR5 } from './fixtures/current-qualification-r5'
import type { QualificationCase } from './fixtures/current-qualification-r4'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness)
afterAll(f.close)
const titles = [
  ['little_giant','little-giant','专精特新“小巨人”'],
  ['specialized_sme','specialized-sme','专精特新中小企业'],
  ['innovative_sme','innovative-sme','创新型中小企业'],
] as const
async function assertCases(cases: QualificationCase[], key: string, permute = false) {
  const entries = cases.map(c => {
    const events = permute ? [...c.events].reverse() : c.events
    const candidate = f.candidate(key+'-'+c.id,events,'little_giant')
    for (const [title] of titles.slice(1)) f.addRecord(candidate.enterprise.id,candidate.enterprise.name,events,title)
    const records = f.db.$client.prepare('select id from record where enterprise_id=?').all(candidate.enterprise.id) as {id:number}[]
    for (const record of records) {
      const ids = f.db.$client.prepare('select id from record_event where record_id=? order by id').all(record.id) as {id:number}[]
      for (const index of c.missing ?? []) f.db.$client.prepare('delete from record_evidence where record_event_id=?').run(ids[permute ? c.events.length-1-index : index]!.id)
    }
    return {...c,...candidate}
  })
  if (permute) {
    const db=f.db.$client
    db.pragma('foreign_keys = OFF')
    try {
      db.exec('update record_event set id=-id; update record_evidence set record_event_id=-record_event_id; update record_evidence set id=-id')
      db.exec('update record_event set id=10000000+(-id*37%1000003); update record_evidence set record_event_id=10000000+(-record_event_id*37%1000003); update record_evidence set id=20000000+(-id*53%1000003)')
    } finally { db.pragma('foreign_keys = ON') }
    expect(db.pragma('foreign_key_check')).toEqual([])
  }
  const before = f.businessDigest()
  for (const [title,slug,label] of titles) {
    const response = await fetch(f.url('/api/roster/exports/current/'+slug),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:key+'-'+title})})
    expect(response.status).toBe(202)
    const accepted=await response.json()
    expect(response.headers.get('location')).toBe('/api/jobs/'+accepted.jobId)
    const job=await f.terminal(accepted.jobId)
    expect(job.state,JSON.stringify(job)).toBe('done')
    expect(job.result.ruleVersion).toBe('current-roster-116-v6')
    const {wb}=await f.download(job)
    const explanation=Object.fromEntries(rows(wb,'口径说明').map(row=>[row[1],row[2]]))
    expect(explanation['规则版本']).toBe('current-roster-116-v6')
    const summary=await (await fetch(f.url('/api/task-center/'+accepted.jobId),{headers:f.headers})).json()
    expect(summary.export.ruleVersion).toBe('current-roster-116-v6')
    const observations=[]
    for (const c of entries) {
      const actual=wb.worksheets.slice(0,3).flatMap(sheet=>rows(wb,sheet.name).filter(row=>row[2]===String(c.enterprise.id)).map(row=>({sheet:sheet.name,row})))
      expect.soft(actual.map(r=>r.sheet),c.id+' '+title).toEqual([c.sheet])
      const row=actual[0]!.row
      expect.soft(row[8],c.id).toBe(label)
      expect.soft(row[9]??null,c.id).toBe(c.first==null?null:String(c.first))
      const stored = f.db.$client.prepare('select e.id,e.revision,v.id as evidenceId from record_event e join record r on r.id=e.record_id left join record_evidence v on v.record_event_id=e.id where r.enterprise_id=? and r.title_code=?').all(c.enterprise.id,title) as {id:number;revision:number;evidenceId:number|null}[]
      const ids = (value: string, pattern: RegExp) => [...String(value??'').matchAll(pattern)].map(m=>Number(m[1])).sort((a,b)=>a-b)
      expect.soft(ids(row[10],/event:(\d+)@/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.id).sort((a,b)=>a-b))
      expect.soft(ids(row[14],/evidence:(\d+)/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.evidenceId).sort((a,b)=>a!-b!))
      expect.soft(row[14]?.match(/evidence:/g)?.length??0,c.id).toBe(c.events.length-(c.missing?.length??0))
      expect.soft(row[14]?.match(/正式出处待补/g)?.length??0,c.id).toBe(c.missing?.length??0)
      if(c.note) expect.soft(row[13]??'',c.id).toContain(c.note)
      observations.push({id:c.id,expected:c.sheet,actual:actual.map(r=>r.sheet),first:row[9]??null,notes:row[13]??''})
    }
    for (const [sheet,group] of [['有效企业','eligible'],['待确认','pending'],['排除明细','excluded']] as const) {
      const expected=entries.filter(c=>c.sheet===sheet).length
      expect.soft(rows(wb,sheet).length,group).toBe(expected)
      expect.soft(job.result.counts[group],group).toBe(expected)
    }
    console.log(JSON.stringify({matrix:key,title,observations}))
  }
  expect(f.businessDigest()).toBe(before)
}
for (const permute of [false,true]) {
  it(`失败时间与未知归属同时保留且仅真实后续认定消解恢复冲突 ${permute?'逆序ID置换':'正序'}`,()=>assertCases(qualificationCasesR5(y).filter(c=>c.id.startsWith('F-')),'r5-failure-'+permute,permute),60000)
  it(`未知认定批次按所有可行归属聚合而一致事实不丢资格 ${permute?'逆序ID置换':'正序'}`,()=>assertCases(qualificationCasesR5(y).filter(c=>c.id.startsWith('G-')),'r5-association-'+permute,permute),60000)
}
