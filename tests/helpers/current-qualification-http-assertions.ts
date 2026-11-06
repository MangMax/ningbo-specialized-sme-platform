import { CURRENT_RULE_VERSION } from '../../lib/roster/current-qualification'
import { expect } from 'vitest'
import { rows, businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity, type currentExport118Fixture } from './current-export-118'
import type { QualificationCase } from '../fixtures/current-qualification-r4'

type ExportFixture = ReturnType<typeof currentExport118Fixture>
export type EffectiveQualificationCase = Omit<QualificationCase, 'sheet' | 'note'> & { sheet: '有效企业' | '已到期' | '未认定' }
type ExportCase = EffectiveQualificationCase & ReturnType<ExportFixture['candidate']>
type ReferenceAssertion = (c: ExportCase, title: string, row: ReturnType<typeof rows>[number]) => void

const titles = [
  ['little_giant','little-giant','专精特新“小巨人”'],
  ['specialized_sme','specialized-sme','专精特新中小企业'],
  ['innovative_sme','innovative-sme','创新型中小企业'],
] as const
// R4 checks reference counts; R5 checks exact IDs. Keep each suite's assertion
// at the same HTTP/XLSX seam while sharing the complete export driver.
export function currentQualificationHttpAssertions(f: ExportFixture, assertReferences: ReferenceAssertion) {
  return async function assertCases(cases: EffectiveQualificationCase[], key: string, permute = false) {
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
      expect(job.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
      const {wb}=await f.download(job)
      const explanation=Object.fromEntries(rows(wb,'口径说明').map(row=>[row[1],row[2]]))
      expect(explanation['规则版本']).toBeUndefined()
      const summary=await (await fetch(f.url('/api/task-center/'+accepted.jobId),{headers:f.headers})).json()
      expect(summary.export.ruleVersion).toBe(CURRENT_RULE_VERSION)
      const observations=[]
      for (const c of entries) {
        const actual=wb.worksheets.slice(0,5).flatMap(sheet=>rows(wb,sheet.name).filter(row=>matchesBusinessIdentity(f.db, row, c.enterprise.id)).map(row=>({sheet:sheet.name,row})))
        expect.soft(actual.map(r=>r.sheet),c.id+' '+title).toEqual([c.sheet])
        const row=actual[0]!.row
        expect.soft(row[5],c.id).toBe(label)
        expect.soft(row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
        assertReferences(c,title,row)
        expect.soft(row[12]?.match(/synthetic-118\.xlsx/g)?.length??0,c.id).toBe(c.events.length-(c.missing?.length??0))
        expect.soft(row[7]?.match(/正式出处待核/g)?.length??0,c.id).toBe(c.missing?.length??0)
        expect.soft(row[13],c.id).toBe(c.sheet)
        if(c.missing?.length) expect.soft(row[15],c.id).toContain('正式公布出处缺失')
        expect.soft(row[7]?.split('\n').length??0,c.id).toBe(c.events.length)
        expect.soft(row[7]?.match(/原认定年份待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.year==null).length)
        expect.soft(row[7]?.match(/结论年份待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.eventType==='review'&&e.decidedYear==null).length)
        expect.soft(row[7]?.match(/复核结论待核/g)?.length??0,c.id).toBe(c.events.filter(e=>e.eventType==='review'&&e.reviewOutcome==null).length)
        observations.push({id:c.id,expected:c.sheet,actual:actual.map(r=>r.sheet),first:row[6]??null,notes:row[11]??''})
      }
      expect(wb.worksheets.map(sheet=>sheet.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
      for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
        const expected=entries.filter(c=>c.sheet===sheet)
        expect.soft(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(expected.map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
      }
      const eligible=entries.filter(c=>c.sheet==='有效企业').length
      expect(job.result.counts).toEqual({eligible,pending:0,excluded:entries.length-eligible})
      expect(job.result.statusCounts).toEqual({effective:eligible,expired:entries.filter(c=>c.sheet==='已到期').length,terminated:0,moved_out:0,unrecognized:entries.filter(c=>c.sheet==='未认定').length})
      console.log(JSON.stringify({matrix:key,title,observations}))
    }
    expect(f.businessDigest()).toBe(before)
  }
}
