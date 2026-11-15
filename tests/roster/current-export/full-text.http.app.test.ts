import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { qualificationExportFixture } from './fixtures/qualification-export'

const f = qualificationExportFixture()
beforeAll(() => f.start(), 60000)
afterAll(() => f.close())
beforeEach(() => f.resetBusiness(), 60000)
it('publishes and downloads complete multiple-source text through the HTTP export job', async () => {
  f.candidate('synthetic-full-text')
  const attachment = 'literal first source\n'.repeat(24) + 'literal second source😀'.repeat(90)
  f.db.$client.prepare('update record_evidence set attachment=?').run(attachment)
  const digest = f.businessDigest()
  const { wb, job, response } = await f.workbook('full-text-public-artifact')
  expect(job.state).toBe('done')
  expect(response.status).toBe(200)
  expect(job.result.total).toBe(1)
  const business = wb.getWorksheet('有效企业')!
  expect(business.rowCount).toBe(2)
  expect(business.getCell('B2').value).toBe('synthetic-full-text')
  expect(business.getCell('L2').value).toBe('全文见「长文本全文」：有效企业!L2')
  const chunks: string[] = []
  wb.getWorksheet('长文本全文')!.eachRow((row,n)=>{if(n>1){expect(row.getCell(2).value).toBe('L2');expect(row.height).toBeLessThanOrEqual(409);chunks.push(String(row.getCell(12).value))}})
  expect(chunks.join('')).toContain(attachment)
  expect(f.businessDigest()).toBe(digest)
})
