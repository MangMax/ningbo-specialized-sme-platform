import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, year as y } from './helpers/current-export-118'
import { qualificationCasesR5 } from './fixtures/current-qualification-r5'
import { currentQualificationHttpAssertions } from './helpers/current-qualification-http-assertions'
import { readCurrentCandidate } from '../lib/roster/current-qualification'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness)
afterAll(f.close)
const assertCases = currentQualificationHttpAssertions(f, (c,title,row) => {
  const stored = f.db.$client.prepare('select e.id,e.revision,v.id as evidenceId from record_event e join record r on r.id=e.record_id left join record_evidence v on v.record_event_id=e.id where r.enterprise_id=? and r.title_code=?').all(c.enterprise.id,title) as {id:number;revision:number;evidenceId:number|null}[]
  const ids = (value: string, pattern: RegExp) => [...String(value??'').matchAll(pattern)].map(m=>Number(m[1])).sort((a,b)=>a-b)
  const audit = readCurrentCandidate(f.db.$client,c.enterprise.id,title as any,y)
  expect.soft(ids(audit.basis,/event:(\d+)@/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.id).sort((a,b)=>a-b))
  expect.soft(ids(audit.references.join('\n'),/evidence:(\d+)/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.evidenceId).sort((a,b)=>a!-b!))
  expect.soft(row[12]?.match(/synthetic-118\.xlsx/g)?.length??0,c.id).toBe(stored.filter(e=>e.evidenceId!=null).length)
  expect.soft(row[7] + row[12],c.id).not.toMatch(/event:|evidence:|revision|sha256:/)
})
for (const permute of [false,true]) {
  it(`失败时间与未知归属同时保留且仅真实后续认定消解恢复冲突 ${permute?'逆序ID置换':'正序'}`,()=>assertCases(qualificationCasesR5(y).filter(c=>c.id.startsWith('F-')),'r5-failure-'+permute,permute),60000)
  it(`未知认定批次按所有可行归属聚合而一致事实不丢资格 ${permute?'逆序ID置换':'正序'}`,()=>assertCases(qualificationCasesR5(y).filter(c=>c.id.startsWith('G-')),'r5-association-'+permute,permute),60000)
}
