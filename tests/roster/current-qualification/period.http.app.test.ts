import { afterAll, beforeAll, expect, it } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'

// Synthetic isolated PostgreSQL data, served through Nuxt and the real read worker.
const f = qualificationExportFixture()
const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
beforeAll(async () => {
  await f.candidate('irregular477', [
    { eventType: 'award', year: year - 5, batchSeq: 1 },
    { eventType: 'review', year: year - 5, decidedYear: year - 2, batchSeq: 1, reviewOutcome: 'passed' },
    { eventType: 'review', year: year - 5, decidedYear: year, batchSeq: 1, reviewOutcome: 'passed' },
    { eventType: 'review', year: year - 5, decidedYear: year + 2, batchSeq: 1, reviewOutcome: 'passed' },
  ])
  await f.candidate('cross-origin477',[
    {eventType:'award',year:year-6,batchSeq:1},
    {eventType:'award',year:year-3,batchSeq:1},
    {eventType:'review',year:year-6,decidedYear:year-1,batchSeq:1,reviewOutcome:'passed'},
  ])
  await f.start()
},60000)
afterAll(() => f.close())
it('public current-enterprises includes an irregularly renewed enterprise despite its future review', async () => {
  const response = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&q=irregular477'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.total).toBe(1)
  expect(body.rows.map((row: { name: string }) => row.name)).toEqual(['irregular477'])
  expect(body.publishedPending.total).toBe(0)
},60000)

it('public reader selects a later actual pass on an older origin',async()=>{
 const body=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&q=cross-origin477')).then(r=>r.json())
 expect(body.rows.map((r:any)=>r.name)).toEqual(['cross-origin477'])
},60000)
