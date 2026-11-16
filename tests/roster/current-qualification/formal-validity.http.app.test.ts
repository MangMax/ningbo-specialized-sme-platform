import { afterAll, beforeAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { schema } from '../../../db/client'

// One owned Nuxt process and real read/export workers for the whole transport check.
const f = qualificationExportFixture()
const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10)
const year = Number(today.slice(0,4))
const samples = [
  { name: 'owned_lanfan', title: 'innovative_sme', path: 'innovative-sme', year: year-3, batch: 2 },
  { name: 'owned_yayan', title: 'specialized_sme', path: 'specialized-sme', year: year-3, batch: null },
  { name: 'owned_yongchuang', title: 'specialized_sme', path: 'specialized-sme', year: year-4, batch: null },
] as const
beforeAll(async () => {
  const spec = await readDevelopmentDiscovery()
  expect(spec.paths['/api/roster/current-enterprises'].get).toBeDefined()
  for (const title of ['specialized-sme', 'innovative-sme', 'little-giant']) {
    expect(spec.paths['/api/roster/exports/current/' + title].post).toBeDefined()
  }
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
}, 120000)
afterAll(() => f.close())
it('real current-qualified HTTP and export artifacts agree for interval and both continuation scopes', async () => {
  const before = f.businessDigest()
  for (const sample of samples) {
    const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=${sample.title}&q=${sample.name}`))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.total).toBe(1)
    expect(result.rows[0].qualificationAssessment).toMatchObject({ ruleVersion: 'current-roster-116-v13', assessmentVersion: 'enterprise-qualification-740-v6' })
  }
  for (const title of ['specialized-sme','innovative-sme']) {
    const response = await fetch(f.url('/api/roster/exports/current/' + title), { method: 'POST', headers: f.headers, body: JSON.stringify({ clientRequestId: 'formal-validity-' + title }) })
    expect(response.status).toBe(202)
    const job = await f.terminal((await response.json()).jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    const { wb } = await f.download(job)
    const expected = title === 'innovative-sme'
      ? ['owned_lanfan', 'owned_yayan', 'owned_yongchuang']
      : ['owned_yayan', 'owned_yongchuang']
    const listed = await fetch(f.url('/api/roster/current-enterprises?titleCode=' + title.replaceAll('-', '_')))
    expect(listed.status).toBe(200)
    const current = await listed.json()
    expect(current.total).toBe(expected.length)
    expect(current.rows.map((row: { name: string }) => row.name).sort()).toEqual([...expected].sort())
    expect(job.result.counts).toEqual({ eligible: expected.length, pending: 0, excluded: 0 })
    const sheet = wb.getWorksheet('有效企业')!
    expect(sheet.rowCount).toBe(expected.length + 1)
    expect(sheet.getRows(2, expected.length)!.map(r => r.getCell(2).value).sort()).toEqual(expected.sort())
    for (const row of sheet.getRows(2, expected.length)!) {
      const name = String(row.getCell(2).value)
      expect(String(row.getCell(14).value)).toContain(name === 'owned_lanfan'
        ? `正式文件有效期：${year-3}-11-01 至 ${today}（含首尾）`
        : `默认年度规则：最近一次认定或复核通过 ${year} 年 + 3 = ${year+3} 年；自 ${year+3} 年起到期（仅年份精度）`)
    }
  }
  expect(f.businessDigest()).toBe(before)
}, 60000)

// Expectations below are business literals, independent of production readers.
// Y-3 expires in Y; Y-2 is still effective (it expired in neither Y-1 nor Y).
it('annual expiry and title inheritance preserve literal HTTP and downloaded identity periods', async () => {
  await f.resetBusiness()
  const continuation = (recordId: number, reviewYear: number | null, kind: 'until_next_review_results' | 'until_this_review_results') => {
    const award = f.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId, recordId)).get()!
    const event = reviewYear === null ? award : f.db.insert(schema.recordEvent).values({
      recordId, eventType: 'review', year: year-6, batchSeq: 1,
      decidedYear: reviewYear === 0 ? null : reviewYear, reviewOutcome: 'passed',
    }).returning().get()!
    const path = `annual-${event.id}.pdf`
    const sha = 'b'.repeat(64)
    f.db.insert(schema.storedFile).values({ relPath: path, filename: path, ext: 'pdf', bytes: 7, sha256: sha }).run()
    const evidence = f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: path, page: 3 }).returning().get()!
    // Publication is today even when the business year is missing or expired.
    const raw = JSON.stringify({ evidenceId: evidence.id, sourceSha256: sha, statementPages: [3],
      ...(event.id === award.id ? {} : { originAwardEventId: award.id }), publishedOn: today, continuation: kind })
    f.db.$client.prepare('UPDATE record_event SET formal_validity=? WHERE id=?').run(raw, event.id)
  }
  const expiredAward = f.candidate('annual_expired_upper', [{ eventType: 'award', year: year-3 }])
  continuation(expiredAward.record.id, null, 'until_next_review_results')
  const expiredReview = f.candidate('annual_expired_review', [{ eventType: 'award', year: year-6, batchSeq: 1 }], 'innovative_sme')
  continuation(expiredReview.record.id, year-3, 'until_this_review_results')
  const missing = f.candidate('annual_missing_business_year', [{ eventType: 'award', year: year-6, batchSeq: 1 }], 'innovative_sme')
  continuation(missing.record.id, 0, 'until_next_review_results')
  // Y-3 was still valid last year, but is expired now: the two expired
  // fixtures above hit that exact first-expired-year boundary.
  const valid = f.candidate('annual_valid_review', [{ eventType: 'award', year: year-6, batchSeq: 1 }], 'innovative_sme')
  continuation(valid.record.id, year-2, 'until_next_review_results')
  const inherited = f.candidate('annual_inherited_period', [{ eventType: 'award', year: year-1 }])
  // Eight-year-old original recognition remains eligible without a passed review.
  f.candidate('annual_inherited_giant', [{ eventType: 'award', year: year-8 }], 'little_giant')
  const own = f.candidate('annual_own_period', [{ eventType: 'award', year: year-1 }])
  f.addRecord(own.enterprise.id, own.enterprise.name, [{ eventType: 'award', year: year-2 }], 'innovative_sme')
  // Include source bytes/hash/page/origin/publication and all raw event columns,
  // not job tables that legitimately change during export.
  const facts = () => ['record_event', 'record_evidence', 'stored_file'].map(table =>
    f.db.$client.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  const before = facts()
  await f.start() // Discovery was inspected before any synthetic setup in beforeAll.
  const annualReview = `默认年度规则：最近一次认定或复核通过 ${year-2} 年 + 3 = ${year+1} 年；自 ${year+1} 年起到期（仅年份精度）`
  const annualUpper = `默认年度规则：最近一次认定或复核通过 ${year-1} 年 + 3 = ${year+2} 年；自 ${year+2} 年起到期（仅年份精度）`
  const retainedGiant = '小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定'
  for (const [title, expected] of [
    ['little_giant', [['annual_inherited_giant', retainedGiant]]],
    ['specialized_sme', [['annual_inherited_giant', retainedGiant], ['annual_inherited_period', annualUpper], ['annual_own_period', annualUpper]]],
    ['innovative_sme', [['annual_inherited_giant', retainedGiant], ['annual_inherited_period', annualUpper], ['annual_own_period', annualReview], ['annual_valid_review', annualReview]]],
  ] as const) {
    const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}`))
    expect(response.status).toBe(200)
    const body = await response.json()
    const identities = expected.map(([name]) => [name, 'SYNTHETIC-118-' + name])
    expect(body.total).toBe(expected.length)
    expect(body.rows.map((r: any) => [r.name, r.uscc]).sort()).toEqual([...identities].sort())
    const submission = await fetch(f.url('/api/roster/exports/current/' + title.replaceAll('_', '-')), {
      method: 'POST', headers: f.headers, body: JSON.stringify({ clientRequestId: 'annual-literals-' + title }),
    })
    expect(submission.status).toBe(202)
    const job = await f.terminal((await submission.json()).jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    const { wb } = await f.download(job)
    const sheet = wb.getWorksheet('有效企业')!
    expect(sheet.rowCount).toBe(expected.length + 1)
    const rows = sheet.getRows(2, expected.length)!
    expect(rows.map(r => [r.getCell(2).value, r.getCell(3).value]).sort()).toEqual([...identities].sort())
    for (const [name, period] of expected) {
      const row = body.rows.find((r: any) => r.name === name)
      const assessment = row.qualificationAssessment.titles.find((t: any) => t.titleCode === title)
      expect(assessment.effectiveQualification.presentationBasis.join('\n'), name).toContain(period)
      const exported = rows.find(r => r.getCell(2).value === name)!
      const basis = String(exported.getCell(14).value)
      expect(basis).toContain(period)
      if (title === 'innovative_sme' && name === 'annual_own_period') {
        expect(assessment.effectiveQualification.presentationBasis.join('\n')).not.toContain(annualUpper)
        expect(basis).not.toContain(annualUpper)
      }
    }
  }
  // Negative identities are absent from BOTH real public surfaces above.
  // Detail retains the original review year separately from its conclusion year.
  for (const [candidate, decidedYear] of [[expiredReview, year-3], [missing, null], [valid, year-2]] as const) {
    const response = await fetch(f.url(`/api/roster/enterprises/${candidate.enterprise.id}`))
    expect(response.status).toBe(200)
    const detail = await response.json()
    const assessment = detail.qualificationAssessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
    expect(assessment.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'review', year: year-6, decidedYear })]))
  }
  expect(facts()).toEqual(before)
}, 60000)
