
import { nativeWorkbookFixture } from './fixtures/native-workbook'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { year as y } from './fixtures/specialized-export'
import { qualificationReferenceCases } from "../current-qualification/fixtures/reference-cases"
import { currentQualificationWorkbookAssertions, type EffectiveQualificationCase } from './assertions/qualification'
import { readCurrentCandidate } from '../../../lib/roster/current-qualification'

const f = nativeWorkbookFixture()
beforeEach(async () => { await f.resetBusiness() }, 90000)
afterAll(f.close)
// Literal #475/#478 native workbook rowsets; the shared fixtures retain historical reader oracles.
const expectedRows = {
'有效企业': ['G-fresh-known', 'G-fresh-null', 'G-fresh-known-null', 'G-fresh-known-null-second-batch', 'G-fresh-all-null', 'G-fresh-passed-known-null', 'G-consistent-passed-null-award', 'G-consistent-passed-no-award', 'G-unknown-review-null-award', 'G-null-review-known-award', 'G-null-passed-all-null', 'G-consistent-passed-known-null', 'G-mixed-pass-unknown-all-null', 'G-undated-review-all-null', 'G-expired-known-fresh-null', 'G-fresh-known-expired-null', 'G-expired-fresh-all-null', 'G-fresh-near-expiry-all-null', 'G-unknown-date-null-award', 'G-unknown-date-all-null', 'G-future-null-award', 'G-unknown-review-date', 'G-old-unknown-review-neutral-null-award', 'G-null-award-before-ambiguous-failure', 'G-null-award-same-ambiguous-failure', 'G-null-award-after-ambiguous-failure', 'F-1-award-failure--2', 'F-1-award-tie-only-pass', 'F-1-award-tie-current-pass', 'F-1-award-tie-later-award', 'F-1-award-undated-failure-current-cycle', 'F-1-review-only-failure--2', 'F-1-review-only-tie-only-pass', 'F-1-review-only-tie-current-pass', 'F-1-review-only-tie-later-award', 'F-1-review-only-undated-failure-current-cycle', 'F-all-null-1-later-award', 'F-null-award-failure--2', 'F-null-award-tie-only-pass', 'F-null-award-tie-current-pass', 'F-null-award-tie-later-award', 'F-null-award-only-pass-no-restoring-award', 'F-null-award-undated-failure-current-cycle', 'F-null-review-only-failure--2', 'F-null-review-only-tie-only-pass', 'F-null-review-only-tie-current-pass', 'F-null-review-only-tie-later-award', 'F-null-review-only-only-pass-no-restoring-award', 'F-null-review-only-undated-failure-current-cycle', 'F-all-null-null-later-award', 'F-1-review-only-failure--1', 'F-1-review-only-failure-0', 'F-1-award-failure--1', 'F-1-award-failure-0', 'F-null-review-only-failure--1', 'F-null-review-only-failure-0', 'F-null-award-failure--1', 'F-null-award-failure-0', 'F-all-null-1-tie', 'F-all-null-1-later-old-failure', 'F-all-null-null-tie', 'F-all-null-null-later-old-failure', 'G-consistent-failed-null-award', 'G-mixed-reviews-null-award', 'G-losing-batch-does-not-remove-current-failure', 'G-mixed-pass-fail-all-null'],
'已到期': ['G-expired-all-null', 'F-1-award-only-pass-no-restoring-award'],
'未认定': ['G-consistent-failed-no-award', 'G-null-failed-all-null', 'G-consistent-failed-known-null', 'G-expired-reviews-all-null', 'F-1-review-only-only-pass-no-restoring-award'],
} as const
function effectiveCases(): EffectiveQualificationCase[] {
  return qualificationReferenceCases(y).map(({note:_legacyNote,...c})=>{
    const membership=Object.entries(expectedRows).filter(([,ids])=>(ids as readonly string[]).includes(c.id))
    expect(membership,c.id+' literal membership').toHaveLength(1)
    return {...c,lowerSheet: ['F-1-award-only-pass-no-restoring-award', 'F-1-review-only-only-pass-no-restoring-award'].includes(c.id) ? '有效企业' as const : undefined,sheet:membership[0]![0] as EffectiveQualificationCase['sheet']}
  })
}
const assertCases = currentQualificationWorkbookAssertions(f, (c,title,row) => {
  const stored = f.db.$client.prepare('select e.id,e.revision,v.id as evidenceId from record_event e join record r on r.id=e.record_id left join record_evidence v on v.record_event_id=e.id where r.enterprise_id=? and r.title_code=?').all(c.enterprise.id,title) as {id:number;revision:number;evidenceId:number|null}[]
  const ids = (value: string, pattern: RegExp) => [...String(value??'').matchAll(pattern)].map(m=>Number(m[1])).sort((a,b)=>a-b)
  const audit = readCurrentCandidate(f.db.$client,c.enterprise.id,title as any,y)
  const [ownBasis,...inheritedBasis] = audit.basis.split('\n按有效小巨人资格计入；')
  const inheritedReferences = audit.references.filter(ref=>ref.startsWith('小巨人依据：'))
  const giantStored = f.db.$client.prepare("select e.id,v.id as evidenceId from record_event e join record r on r.id=e.record_id left join record_evidence v on v.record_event_id=e.id where r.enterprise_id=? and r.title_code='little_giant'").all(c.enterprise.id) as {id:number;evidenceId:number|null}[]
  // Literal cases whose own period is terminated but whose giant cycle remains usable.
  const inherits = title !== 'little_giant' && ['F-1-review-only-failure--1', 'F-1-review-only-failure-0', 'F-1-award-failure--1', 'F-1-award-failure-0', 'F-null-review-only-failure--1', 'F-null-review-only-failure-0', 'F-null-award-failure--1', 'F-null-award-failure-0', 'F-all-null-1-tie', 'F-all-null-1-later-old-failure', 'F-all-null-null-tie', 'F-all-null-null-later-old-failure', 'G-consistent-failed-null-award', 'G-mixed-reviews-null-award', 'G-losing-batch-does-not-remove-current-failure', 'G-mixed-pass-fail-all-null'].includes(c.id)
  expect.soft(inheritedBasis.length,c.id+' inheritance source').toBe(inherits?1:0)
  expect.soft(ids(inheritedBasis.join('\n'),/event:(\d+)@/g),c.id+' inherited event ids').toEqual(inherits?giantStored.filter(e=>e.evidenceId!=null).map(e=>e.id).sort((a,b)=>a-b):[])
  expect.soft(ids(inheritedReferences.join('\n'),/evidence:(\d+)/g),c.id+' inherited evidence ids').toEqual(inherits?giantStored.filter(e=>e.evidenceId!=null).map(e=>e.evidenceId!).sort((a,b)=>a-b):[])
  expect.soft(ids(ownBasis!,/event:(\d+)@/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.id).sort((a,b)=>a-b))
  expect.soft(ids(audit.references.filter(ref=>!ref.startsWith('小巨人依据：')).join('\n'),/evidence:(\d+)/g),c.id).toEqual(stored.filter(e=>e.evidenceId!=null).map(e=>e.evidenceId).sort((a,b)=>a!-b!))
  expect.soft(row[12]?.match(/synthetic-118\.xlsx/g)?.length??0,c.id).toBe(stored.filter(e=>e.evidenceId!=null).length)
  expect.soft(row[7] + row[12],c.id).not.toMatch(/event:|evidence:|revision|sha256:/)
})
for (const permute of [false,true]) {
  // F and G are independent enterprises in the same literal rowset oracle.
  it(`失败恢复及未知批次完整矩阵 ${permute?'逆序ID置换':'正序'}`,
    ()=>assertCases(effectiveCases(),'r5-complete-'+permute,permute),60000)
}
