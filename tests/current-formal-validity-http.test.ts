import { afterAll, beforeAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { currentExport409Fixture } from './helpers/current-export-409'
import { schema } from '../db/client'

// One owned Nuxt process and real read/export workers for the whole transport check.
const f = currentExport409Fixture()
const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10)
const year = Number(today.slice(0,4))
const samples = [
  { name: 'owned_lanfan', title: 'innovative_sme', path: 'innovative-sme', year: year-3, batch: 2 },
  { name: 'owned_yayan', title: 'specialized_sme', path: 'specialized-sme', year: year-3, batch: null },
  { name: 'owned_yongchuang', title: 'specialized_sme', path: 'specialized-sme', year: year-4, batch: null },
] as const
beforeAll(async () => {
  for (const sample of samples) {
    const target = f.candidate(sample.name, [{ eventType: 'award', year: sample.year, batchSeq: sample.batch }], sample.title)
    const award = f.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId,target.record.id)).get()!
    const review = sample.name === 'owned_lanfan' ? null : f.db.insert(schema.recordEvent).values({ recordId: target.record.id, eventType: 'review', year: sample.year, batchSeq: sample.name === 'owned_yayan' ? 1 : null, decidedYear: year, reviewOutcome: 'passed' }).returning().get()
    const path = sample.name + '.pdf', sha = 'a'.repeat(64)
    f.db.insert(schema.storedFile).values({ relPath: path, filename: path, ext: 'pdf', bytes: 1, sha256: sha }).run()
    const event = review ?? award
    const evidence = f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: path, page: 2 }).returning().get()
    const fact = { evidenceId: evidence.id, sourceSha256: sha, statementPages: [2], ...(review ? { originAwardEventId: award.id, publishedOn: today, continuation: sample.name === 'owned_yayan' ? 'until_next_review_results' : 'until_this_review_results' } : { interval: { validFrom: `${sample.year}-11-01`, validThrough: today } }) }
    f.db.$client.prepare('UPDATE record_event SET formal_validity=? WHERE id=?').run(JSON.stringify(fact), event.id)
  }
  await f.start()
}, 60000)
afterAll(() => f.close())
it('real current-qualified HTTP and export artifacts agree for interval and both continuation scopes', async () => {
  for (const sample of samples) {
    const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=${sample.title}&q=${sample.name}`))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.total).toBe(1)
    expect(result.rows[0].qualificationAssessment).toMatchObject({ ruleVersion: 'current-roster-116-v10', assessmentVersion: 'enterprise-qualification-478-v3' })
  }
  for (const title of ['specialized-sme','innovative-sme']) {
    const response = await fetch(f.url('/api/roster/exports/current/' + title), { method: 'POST', headers: f.headers, body: JSON.stringify({ clientRequestId: 'formal-validity-' + title }) })
    expect(response.status).toBe(202)
    const job = await f.terminal((await response.json()).jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    const { wb } = await f.download(job)
    const expected = samples.filter(s => s.path === title).map(s => s.name)
    expect(job.result.counts).toEqual({ eligible: expected.length, pending: 0, excluded: 0 })
    const sheet = wb.getWorksheet('有效企业')!
    expect(sheet.getRows(2, expected.length)!.map(r => r.getCell(2).value).sort()).toEqual(expected.sort())
  }
}, 60000)
