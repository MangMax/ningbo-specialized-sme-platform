import { CURRENT_RULE_VERSION } from '../../../../layers/sme-roster/lib/roster/current-qualification-model'
import { eq } from 'drizzle-orm'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { expect } from 'vitest'
import { rows, businessIdentity } from '../fixtures/specialized-export'
import type { QualificationCase } from "../../current-qualification/fixtures/cycle-cases"

type ExportFixture = ReturnType<typeof import('../fixtures/native-workbook').nativeWorkbookFixture>
export type EffectiveQualificationCase = Omit<QualificationCase, 'sheet' | 'note'> & { sheet: '有效企业' | '已到期' | '未认定'; lowerSheet?: '有效企业' | '已到期' | '未认定' }
type ExportCase = EffectiveQualificationCase & Awaited<ReturnType<ExportFixture['candidate']>>
type ReferenceAssertion = (c: ExportCase, title: string, row: ReturnType<typeof rows>[number]) => void | Promise<void>

const titles = [
  ['little_giant','little-giant','专精特新“小巨人”'],
  ['specialized_sme','specialized-sme','专精特新中小企业'],
  ['innovative_sme','innovative-sme','创新型中小企业'],
] as const
// R4 checks reference counts; R5 checks exact IDs. Keep each suite's assertion
// at the native reader/writer seam while sharing the complete export driver.
export function currentQualificationWorkbookAssertions(f: ExportFixture, assertReferences: ReferenceAssertion) {
  return async function assertCases(cases: EffectiveQualificationCase[], key: string, permute = false) {
    if (permute) {
      await f.runtimeQuery('ALTER SEQUENCE business.record_event_id_seq RESTART WITH 10000000', [])
      await f.runtimeQuery('ALTER SEQUENCE business.record_evidence_id_seq RESTART WITH 20000000', [])
    }
    const storedEntries = []
    for (const c of cases) {
      const events = permute ? [...c.events].reverse() : c.events
      const candidate = await f.candidate(key + '-' + c.id, events, 'little_giant')
      for (const [title] of titles.slice(1)) await f.addRecord(candidate.enterprise.id, candidate.enterprise.name, events, title)
      const records = await f.db.select({ id: record.id }).from(record).where(eq(record.enterpriseId, candidate.enterprise.id))
      for (const owner of records) {
        const ids = await f.db.select({ id: recordEvent.id }).from(recordEvent).where(eq(recordEvent.recordId, owner.id)).orderBy(recordEvent.id)
        for (const index of c.missing ?? []) {
          await f.db.delete(recordEvidence).where(eq(recordEvidence.recordEventId, ids[permute ? c.events.length - 1 - index : index]!.id))
        }
      }
      storedEntries.push({ ...c, ...candidate })
    }
    const before = await f.businessDigest()
    for (const [title,,label] of titles) {
      const entries = storedEntries.map(c => ({...c,sheet:title === 'little_giant' ? c.sheet : c.lowerSheet ?? c.sheet}))
      const { wb, result } = await f.workbook(key + '-' + title, title)
      expect(result.ruleVersion).toBe(CURRENT_RULE_VERSION)
      const explanation=Object.fromEntries(rows(wb,'口径说明').map(row=>[row[1],row[2]]))
      expect(explanation['规则版本']).toBeUndefined()
      for (const c of entries) {
        const actual=wb.worksheets.slice(0,5).flatMap(sheet=>rows(wb,sheet.name).filter(row=>row[2] === c.enterprise.name && row[3] === c.enterprise.usccNorm).map(row=>({sheet:sheet.name,row})))
        expect.soft(actual.map(r=>r.sheet),c.id+' '+title).toEqual([c.sheet])
        const row=actual[0]!.row
        expect.soft(row[5],c.id).toBe(label)
        expect.soft(row[6]??null,c.id).toBe(c.first==null?null:String(c.first))
        await assertReferences(c,title,row)
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
        expect.soft(rows(wb,sheet).map(row=>businessIdentity(row)),sheet).toEqual(expected.map(c=>[c.enterprise.name, c.enterprise.usccNorm]))
      }
      const eligible=entries.filter(c=>c.sheet==='有效企业').length
      expect(result.counts).toEqual({eligible,pending:0,excluded:entries.length-eligible})
      expect(result.statusCounts).toEqual({effective:eligible,expired:entries.filter(c=>c.sheet==='已到期').length,terminated:0,moved_out:0,unrecognized:entries.filter(c=>c.sheet==='未认定').length})
    }
    expect(await f.businessDigest()).toBe(before)
  }
}
