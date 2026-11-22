
import { nativeWorkbookFixture } from './fixtures/native-workbook'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { rows, year as y } from './fixtures/specialized-export'
import { qualificationCycleCases } from "../current-qualification/fixtures/cycle-cases"
import { currentQualificationWorkbookAssertions, type EffectiveQualificationCase } from './assertions/qualification'

const f = nativeWorkbookFixture()
beforeEach(async () => { await f.resetBusiness() }, 90000)
afterAll(f.close)

// Literal #475/#478 native workbook rowsets; the shared fixtures retain historical reader oracles.
const expectedRows = {
'有效企业': ['A-batches-passed', 'A-batches-fresh', 'A-batches-no-review', 'A-batches-unknown', 'A-batches-undated', 'B-later-reaward-resolves-tie', 'B-only-same-year-reaward', 'B-later-passed-does-not-resolve-tie', 'C-unknown-before-award', 'C-unknown-and-failed-before-award', 'C-batch-gap-before-award', 'C-unknown-before-only-passed', 'C-unknown-same-year-award', 'C-unknown-after-award', 'C-undated-unknown-with-award', 'C-old-pass-gap-before-current-pass', 'C-failed-batch-gap-before-only-passed', 'D-old-unproven-award-before-renewal', 'D-old-proven-award-before-renewal', 'D-old-unproven-award-same-year-renewal', 'D-old-proven-award-same-year-renewal', 'D-old-unproven-award-after-renewal', 'D-old-proven-award-after-renewal', 'D-independent-renewal-only', 'D-unproven-current-award', 'D-unproven-current-review', 'D-unproven-unknown-origin-award', 'A-batches-mixed', 'D-old-unproven-review-after-renewal', 'R3-cross-cycle-same-conclusion', 'R3-independent-failure-then-passed'],
'已到期': ['A-batches-failed', 'B-later-terminal-resolves-tie', 'C-unknown-before-failed', 'C-unknown-same-year-failed', 'C-unknown-after-failed', 'C-undated-unknown-with-failed', 'C-batch-gap-before-failed', 'C-failed-then-only-passed'],
'未认定': [],
} as const
function effectiveCases(): EffectiveQualificationCase[] {
  return qualificationCycleCases(y).map(({note:_legacyNote,...c})=>{
    const membership=Object.entries(expectedRows).filter(([,ids])=>(ids as readonly string[]).includes(c.id))
    expect(membership,c.id+' literal membership').toHaveLength(1)
    return {...c,lowerSheet: ['C-failed-then-only-passed', 'R3-independent-failure-then-passed'].includes(c.id) ? '有效企业' as const : undefined,sheet:membership[0]![0] as EffectiveQualificationCase['sheet']}
  })
}
const assertCases = currentQualificationWorkbookAssertions(f, (c,_title,row) => {
  expect.soft(row[7]?.split('\n').filter((line:string) => !line.includes('正式出处待核')).length??0,c.id).toBe(c.events.length-(c.missing?.length??0))
})
// All literal A/B/C/D/R3 partitions share one workbook per title and ordering.
// Separate DB generations still isolate normal order from permuted IDs.
for (const permute of [false, true]) {
  it(`三称号完整批次恢复出处矩阵 ${permute ? '逆序ID置换' : '正序'}`,
    () => assertCases(effectiveCases(), 'r4-complete-' + permute, permute), 60000)
}
