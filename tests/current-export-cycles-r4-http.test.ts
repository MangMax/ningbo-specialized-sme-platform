import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { currentExport118Fixture, year as y } from './helpers/current-export-118'
import { qualificationCasesR4 } from './fixtures/current-qualification-r4'
import { currentQualificationHttpAssertions } from './helpers/current-qualification-http-assertions'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness)
afterAll(f.close)
const assertCases = currentQualificationHttpAssertions(f, (c,_title,row) => {
  expect.soft(row[7]?.split('\n').filter((line:string) => !line.includes('正式出处待核')).length??0,c.id).toBe(c.events.length-(c.missing?.length??0))
})
it('一致批次保留确定资格而混合与未决批次保留具体缺口',()=>assertCases(qualificationCasesR4(y).filter(c=>c.id.startsWith('A-')),'r4-batches'),60000)

it('后续真实认定消解历史恢复冲突而仅通过不能消解',()=>assertCases(qualificationCasesR4(y).filter(c=>c.id.startsWith('B-')),'r4-recovery'),60000)

it('旧缺口按后续授予延续终止的实际作用消解而同年及未定序仍待核',()=>assertCases(qualificationCasesR4(y).filter(c=>c.id.startsWith('C-')),'r4-applicability'),60000)

it('旧认定出处有无不改变独立延续资格而当前归属缺口仍待核',()=>assertCases(qualificationCasesR4(y).filter(c=>c.id.startsWith('D-')),'r4-provenance'),60000)

it('完整判定矩阵在三称号逆序及事件出处ID置换后保持字面集合',()=>assertCases(qualificationCasesR4(y),'r4-reversed-ids',true),60000)

it('前轮不同周期同年与独立失败后仅通过原例在三称号保持裁定',()=>assertCases(qualificationCasesR4(y).filter(c=>c.id.startsWith('R3-')),'r4-prior-controls'),60000)
