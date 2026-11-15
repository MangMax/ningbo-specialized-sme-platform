import { CURRENT_RULE_VERSION } from '../../../../lib/roster/current-qualification'
import { expect } from 'vitest'
import { rows, businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from '../fixtures/specialized-export'
import type { QualificationCase } from "../../current-qualification/fixtures/cycle-cases"

type ExportFixture = ReturnType<typeof import('../fixtures/native-workbook').nativeWorkbookFixture>
export type EffectiveQualificationCase = Omit<QualificationCase, 'sheet' | 'note'> & { sheet: '有效企业' | '已到期' | '未认定' }
type ExportCase = EffectiveQualificationCase & ReturnType<ExportFixture['candidate']>
type ReferenceAssertion = (c: ExportCase, title: string, row: ReturnType<typeof rows>[number]) => void

const titles = [
  ['little_giant','little-giant','专精特新“小巨人”'],
  ['specialized_sme','specialized-sme','专精特新中小企业'],
  ['innovative_sme','innovative-sme','创新型中小企业'],
] as const
// R4 checks reference counts; R5 checks exact IDs. Keep each suite's assertion
// at the native reader/writer seam while sharing the complete export driver.
export function currentQualificationWorkbookAssertions(f: ExportFixture, assertReferences: ReferenceAssertion) {
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
    for (const [title,,label] of titles) {
      const { wb, result } = await f.workbook(key + '-' + title, title)
      expect(result.ruleVersion).toBe(CURRENT_RULE_VERSION)
      const explanation=Object.fromEntries(rows(wb,'口径说明').map(row=>[row[1],row[2]]))
      expect(explanation['规则版本']).toBeUndefined()
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
      }
      expect(wb.worksheets.map(sheet=>sheet.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
      for (const sheet of ['有效企业','已到期','已注销（吊销）','已迁出','未认定']) {
        const expected=entries.filter(c=>c.sheet===sheet)
        expect.soft(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(expected.map(c=>expectedBusinessIdentity(f.db,c.enterprise.id)))
      }
      const eligible=entries.filter(c=>c.sheet==='有效企业').length
      expect(result.counts).toEqual({eligible,pending:0,excluded:entries.length-eligible})
      expect(result.statusCounts).toEqual({effective:eligible,expired:entries.filter(c=>c.sheet==='已到期').length,terminated:0,moved_out:0,unrecognized:entries.filter(c=>c.sheet==='未认定').length})
    }
    expect(f.businessDigest()).toBe(before)
  }
}
