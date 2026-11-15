import { afterAll, beforeAll, expect, it } from 'vitest'
import { qualificationExportFixture } from './fixtures/qualification-export'
const f=qualificationExportFixture()
beforeAll(()=>f.start(),90000)
afterAll(f.close)
it('preserves idempotency rejected filters and authenticated artifact boundaries', async () => {
  const response=await f.submit('L409-dedup'); expect(response.status).toBe(202)
  const id=(await response.json()).jobId
  expect((await (await f.submit('L409-dedup')).json()).jobId).toBe(id)
  const job=await f.terminal(id);expect(job.state).toBe('done')
  expect((await fetch(f.url(job.result.artifact.downloadUrl))).status).toBe(401)
  expect((await f.submit('L409-invalid',{page:1,q:'filtered'})).status).toBe(400)
  expect((await fetch(f.url('/api/roster/exports/current/innovative-sme'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'L409-dedup'})})).status).toBe(409)
},30000)
