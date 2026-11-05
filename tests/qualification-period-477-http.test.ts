import { afterAll, beforeAll, expect, it } from 'vitest'
import { currentExport409Fixture } from './helpers/current-export-409'

// Synthetic isolated SQLite; real Nuxt HTTP and read worker, no vendor/production evidence.
const f = currentExport409Fixture()
const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
beforeAll(async () => {
  f.candidate('irregular477', [
    { eventType: 'award', year: year - 5, batchSeq: 1 },
    { eventType: 'review', year: year - 5, decidedYear: year - 2, batchSeq: 1, reviewOutcome: 'passed' },
    { eventType: 'review', year: year - 5, decidedYear: year, batchSeq: 1, reviewOutcome: 'passed' },
    { eventType: 'review', year: year - 5, decidedYear: year + 2, batchSeq: 1, reviewOutcome: 'passed' },
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
