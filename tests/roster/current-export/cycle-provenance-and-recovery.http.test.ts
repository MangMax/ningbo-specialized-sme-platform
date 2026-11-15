import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, year as y } from '../../helpers/current-export-118'
import { qualificationCasesR4 } from '../../fixtures/current-qualification-r4'
import { currentQualificationHttpAssertions, type EffectiveQualificationCase } from '../../helpers/current-qualification-http-assertions'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness, 90000)
afterAll(f.close)
// Literal #475/#478 HTTP rowsets; the shared fixtures retain historical reader oracles.
const expectedRows = {
'有效企业': ['A-batches-passed', 'A-batches-fresh', 'A-batches-no-review', 'A-batches-unknown', 'A-batches-undated', 'B-later-reaward-resolves-tie', 'B-later-passed-does-not-resolve-tie', 'C-unknown-before-award', 'C-unknown-and-failed-before-award', 'C-batch-gap-before-award', 'C-unknown-before-only-passed', 'C-failed-then-only-passed', 'C-unknown-same-year-award', 'C-unknown-after-award', 'C-undated-unknown-with-award', 'C-old-pass-gap-before-current-pass', 'C-failed-batch-gap-before-only-passed', 'D-old-unproven-award-before-renewal', 'D-old-proven-award-before-renewal', 'D-old-unproven-award-same-year-renewal', 'D-old-proven-award-same-year-renewal', 'D-old-unproven-award-after-renewal', 'D-old-proven-award-after-renewal', 'D-independent-renewal-only', 'D-unproven-current-award', 'D-unproven-current-review', 'D-unproven-unknown-origin-award', 'R3-independent-failure-then-passed'],
'已到期': ['A-batches-failed', 'A-batches-mixed', 'B-later-terminal-resolves-tie', 'B-only-same-year-reaward', 'C-unknown-before-failed', 'C-unknown-same-year-failed', 'C-unknown-after-failed', 'C-undated-unknown-with-failed', 'C-batch-gap-before-failed', 'D-old-unproven-review-after-renewal', 'R3-cross-cycle-same-conclusion'],
'未认定': [],
} as const
function effectiveCases(): EffectiveQualificationCase[] {
  return qualificationCasesR4(y).map(({note:_legacyNote,...c})=>{
    const membership=Object.entries(expectedRows).filter(([,ids])=>(ids as readonly string[]).includes(c.id))
    expect(membership,c.id+' literal membership').toHaveLength(1)
    return {...c,sheet:membership[0]![0] as EffectiveQualificationCase['sheet']}
  })
}
const assertCases = currentQualificationHttpAssertions(f, (c,_title,row) => {
  expect.soft(row[7]?.split('\n').filter((line:string) => !line.includes('正式出处待核')).length??0,c.id).toBe(c.events.length-(c.missing?.length??0))
})
it('三称号各批次失败优先且未决资料仅备注不覆盖有效期间',()=>assertCases(effectiveCases().filter(c=>c.id.startsWith('A-')),'r4-batches'),60000)

it('较晚正式认定或通过恢复资格且同年失败优先',()=>assertCases(effectiveCases().filter(c=>c.id.startsWith('B-')),'r4-recovery'),60000)

it('旧缺口仅备注且正式期间按较晚通过认定与失败裁定',()=>assertCases(effectiveCases().filter(c=>c.id.startsWith('C-')),'r4-applicability'),60000)

it('当前及历史出处归属缺口仅备注并保留正式期间及真实首次历史',()=>assertCases(effectiveCases().filter(c=>c.id.startsWith('D-')),'r4-provenance'),60000)

it('完整判定矩阵在三称号逆序及事件出处ID置换后保持字面集合',()=>assertCases(effectiveCases(),'r4-reversed-ids',true),60000)

it('三称号不同周期同年失败优先且较晚正式通过恢复资格',()=>assertCases(effectiveCases().filter(c=>c.id.startsWith('R3-')),'r4-prior-controls'),60000)
