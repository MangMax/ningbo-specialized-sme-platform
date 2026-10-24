import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { useDb, schema as s } from '../db/client'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { ANNUAL_CORRESPONDENCE_KIND, type AnnualTaskResult } from '../lib/roster/annual-correspondence'
import { createImportExecutor } from '../server/utils/import-execution'
import { commitRosterImport } from '../server/utils/roster-import'
import { readAnnualWriteScope } from '../server/utils/annual-correspondence-read'
import * as annual from '../server/utils/jobs/annual-correspondence'
import { activateCandidateDiscoveryTasks, retryCandidateDiscovery, submitCandidateDiscovery, type CandidateJobResult } from '../server/utils/jobs/candidate-discovery'
import { __resetJobRunner, clearJobSpecs, ensureJobRunnerReady, requestJobCancel, whenIdle } from '../server/utils/job-runner'
import { getJob } from '../server/utils/job-store'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import { startRosterApi } from './helpers/roster-http-server'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  await whenIdle()
  vi.restoreAllMocks()
  __resetJobRunner(); clearJobSpecs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture(count = 1, existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'archive-annual-259-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'synthetic.db'), db = useDb({ dbPath: path })
  cleanups.push(() => db.$client.close())
  __resetJobRunner(); clearJobSpecs(); ensureJobRunnerReady(db)
  // Synthetic initial roster only. Archives, projection and all correspondence
  // decisions below go through the actual import or correspondence domains.
  const enterprise = db.insert(s.enterprise).values({ name: '归档年度合成企业', nameNorm: '归档年度合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const events = Array.from({ length: count }, (_, i) => db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, batchSeq: i + 1 }).returning().get())
  const relation = (n: number) => ({ sequenceNo: n, relationKey: `BUS-${n}`, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm,
    verificationStatus: 'confirmed' as const, rawFields: { id: `BUS-${n}`, sblx: '申请', year: 2024, sqsj: `2024-${n === 1 ? '01' : '12'}-01`, cszt: '终审通过' } })
  const input = (n = 1): RosterImportRequest => ({ idempotencyKey: `synthetic-archive-${n}`, sourceKind: 'platform_archive', sourceIdentity: 'synthetic/annual-archive', payload: { platformQueries: [{
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-24T00:00:00Z', status: 'success', rawResponse: 'synthetic original archive', relations: [relation(n)],
  }] } })
  const jobs = () => db.select().from(s.job).where(eq(s.job.kind, ANNUAL_CORRESPONDENCE_KIND)).all()
  const audits = () => db.select().from(s.recordCorrespondenceAudit).all()
  const rows = () => db.select().from(s.recordCorrespondence).all()
  const chain = (id: string) => {
    const result = [getJob(db, id)!]
    while ((result.at(-1)!.result as CandidateJobResult)?.continuationJobId)
      result.push(getJob(db, (result.at(-1)!.result as CandidateJobResult).continuationJobId!)!)
    return result
  }
  return { db, dir, path, enterprise, record, events, input, jobs, audits, rows, chain }
}
async function http(f: ReturnType<typeof fixture>, options: Parameters<typeof createImportExecutor>[0] = {}) {
  const executor = createImportExecutor(options)
  cleanups.push(() => executor.close())
  const api = await startRosterApi({ db: f.db, apiToken: 'synthetic-259', executeImport: executor.execute })
  cleanups.push(() => api.close())
  const post = async (body = f.input()) => {
    const response = await fetch(`${api.baseUrl}/api/roster/import/commit`, { method: 'POST', headers: { authorization: 'Bearer synthetic-259', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return await response.json() as ReturnType<typeof commitRosterImport>
  }
  return { executor, post }
}
function expectAnnualDone(f: ReturnType<typeof fixture>, eventIds: number[], taskCount: number) {
  const jobs = f.jobs()
  expect(jobs).toHaveLength(taskCount)
  expect(jobs.every(j => j.state === 'done')).toBe(true)
  const events = jobs.flatMap(j => (j.result as AnnualTaskResult).events)
  expect(events.map(e => e.eventId).sort((a, b) => a - b)).toEqual(eventIds)
  expect(events.every(e => e.status === 'done')).toBe(true)
  expect(events.every(e => e.outcomes.length > 0 && e.outcomes.every(o => ['created', 'existing'].includes(o.status)))).toBe(true)
  expect(events.every(e => e.finalQualification.status === 'confirmed')).toBe(true)
}

it('native HTTP archive processes only affected events and repeated receipts never duplicate annual audits', async () => {
  const f = fixture(), api = await http(f)
  const other = f.db.insert(s.enterprise).values({ name: '无关合成企业', nameNorm: '无关合成企业', usccNorm: '91330211790043112T' }).returning().get()
  for (const values of [
    { enterpriseId: other.id, titleCode: 'specialized_sme', source: 'jxj' as const },
    { enterpriseId: f.enterprise.id, titleCode: 'innovative_sme', source: 'jxj' as const },
    { enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', source: 'miit' as const },
  ]) {
    const record = f.db.insert(s.record).values(values).returning().get()
    f.db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).run()
  }
  f.db.insert(s.recordEvent).values({ recordId: f.record.id, eventType: 'maintain', year: 2024 }).run()
  const receipt = await api.post()
  expect(receipt.status).toBe('committed')
  await api.executor.close(); await whenIdle()
  expectAnnualDone(f, [f.events[0]!.id], 1)
  expect(f.rows()).toMatchObject([{ eventId: f.events[0]!.id, status: 'confirmed', role: 'context_only' }])
  const before = { jobs: f.jobs(), audit: f.audits() }
  activateCandidateDiscoveryTasks(f.db, receipt.candidateTaskIds, f.dir)
  const executor2 = createImportExecutor(); cleanups.push(() => executor2.close())
  expect(await executor2.execute(f.db, 'commit', f.input())).toEqual(receipt)
  await whenIdle()
  expect({ jobs: f.jobs(), audit: f.audits() }).toEqual(before)
})

it('401 affected events and appended same-query sources get complete new annual slices beyond old DONE continuations', async () => {
  const f = fixture(401), api = await http(f)
  const eventIds = f.events.map(e => e.id)
  const first = await api.post(); await whenIdle()
  const oldCandidates = f.chain(first.candidateTaskIds[0]!)
  expect(oldCandidates.map(j => (j.result as CandidateJobResult).items.length)).toEqual([200, 200, 1])
  expectAnnualDone(f, eventIds, 3)
  expect(f.jobs().map(j => (j.params.eventIds as number[]).length).sort((a, b) => a - b)).toEqual([1, 200, 200])
  const oldAnnual = f.jobs(), oldAudit = f.audits()
  const second = await api.post(f.input(2)); await whenIdle()
  const nextCandidates = f.chain(second.candidateTaskIds[0]!)
  expect(nextCandidates.map(j => (j.result as CandidateJobResult).items.length)).toEqual([200, 200, 1])
  expect(nextCandidates.every(j => !oldCandidates.some(old => old.id === j.id))).toBe(true)
  expect(nextCandidates.slice(1).map(j => j.params.archiveGeneration)).toEqual([second.candidateTaskIds[0], second.candidateTaskIds[0]])
  const freshAnnual = f.jobs().filter(j => !oldAnnual.some(old => old.id === j.id))
  expect(freshAnnual).toHaveLength(3)
  expect(freshAnnual.map(j => (j.params.eventIds as number[]).length).sort((a, b) => a - b)).toEqual([1, 200, 200])
  expect(freshAnnual.every(j => j.state === 'done')).toBe(true)
  const events = freshAnnual.flatMap(j => (j.result as AnnualTaskResult).events)
  expect(events.map(e => e.eventId).sort((a, b) => a - b)).toEqual(eventIds)
  for (const event of events) {
    const old = oldAnnual.flatMap(j => (j.result as AnnualTaskResult).events).find(e => e.eventId === event.eventId)!
    expect(event.generation).not.toBe(old.generation)
    expect(event).toMatchObject({ status: 'done', finalQualification: { status: 'confirmed' } })
    expect(event.outcomes).toHaveLength(2)
  }
  const lastRelation = f.db.select().from(s.platformRelation).where(eq(s.platformRelation.sequenceNo, 2)).get()!
  expect(f.db.select().from(s.recordCorrespondence).where(and(eq(s.recordCorrespondence.eventId, eventIds[400]!), eq(s.recordCorrespondence.relationId, lastRelation.id))).get()).toMatchObject({ status: 'confirmed', role: 'context_only' })
  expect(f.audits().filter(a => oldAudit.some(old => old.id === a.id))).toEqual(oldAudit)
  const before = { jobs: f.jobs(), audit: f.audits() }
  expect((await api.post(f.input(2))).candidateTaskIds).toEqual(second.candidateTaskIds)
  activateCandidateDiscoveryTasks(f.db, second.candidateTaskIds, f.dir); await whenIdle()
  expect({ jobs: f.jobs(), audit: f.audits() }).toEqual(before)
}, 120_000)

it('rolls annual staging back with its candidate checkpoint and retries without duplicate business audit', async () => {
  const f = fixture()
  // Fault injection after stage has inserted the annual job, before the same
  // transaction can commit its candidate checkpoint. No business fixtures mutate.
  f.db.$client.exec(`CREATE TRIGGER abort_259_checkpoint BEFORE UPDATE ON job
    WHEN NEW.kind = 'event-archive-candidates' AND EXISTS (SELECT 1 FROM job WHERE kind = 'event-annual-correspondence')
    BEGIN SELECT RAISE(ABORT, '259 checkpoint rollback'); END`)
  const receipt = commitRosterImport(f.db, f.input()); await whenIdle()
  expect(getJob(f.db, receipt.candidateTaskIds[0]!)?.state).toBe('failed')
  expect(f.jobs()).toEqual([])
  const audit = f.audits()
  expect(audit.length).toBeGreaterThan(0)
  f.db.$client.exec('DROP TRIGGER abort_259_checkpoint')
  retryCandidateDiscovery(f.db, receipt.candidateTaskIds[0]!, f.dir); await whenIdle()
  expectAnnualDone(f, [f.events[0]!.id], 1)
  expect(f.audits().filter(a => audit.some(old => old.id === a.id))).toEqual(audit)
})

it('a rolled-back archive parent leaves no candidate or annual jobs', async () => {
  const f = fixture()
  expect(() => f.db.transaction(() => { commitRosterImport(f.db, f.input(), [], { deferCandidateTasks: true }); throw Error('outer rollback') })).toThrow('outer rollback')
  await whenIdle()
  expect(f.db.select().from(s.job).all()).toEqual([])
  expect(f.db.select().from(s.platformQuery).all()).toEqual([])
  expect(f.audits()).toEqual([])
})

it.each([{ name: 'rejected', status: 'rejected' as const }, { name: 'unlinked', status: 'unlinked' as const }])('automatic archive annual processing preserves manual $name', async ({ status }) => {
  const f = fixture()
  const activate = annual.activateAnnualCorrespondence
  const manual = (next: 'confirmed' | 'rejected' | 'unlinked') => {
    const row = f.rows()[0]!
    const request: CorrespondenceRequest = { idempotencyKey: `synthetic-manual-${next}`, sourceIdentity: 'synthetic/manual', actor: { type: 'user', id: 'reviewer' }, basis: 'explicit decision before annual activation', ruleId: 'manual', ruleVersion: '1',
      operations: [{ action: 'decide', correspondenceId: row.id, expectedRevision: row.revision, status: next }] }
    commitRecordCorrespondences(f.db, request, preflightRecordCorrespondences(f.db, request).planHash)
  }
  const spy = vi.spyOn(annual, 'activateAnnualCorrespondence').mockImplementation((db, read, ids, filesDir) => {
    if (status === 'unlinked') manual('confirmed')
    manual(status)
    activate(db, read, ids, filesDir)
  })
  const first = commitRosterImport(f.db, f.input()); await whenIdle()
  expect(spy).toHaveBeenCalledOnce(); spy.mockRestore()
  expect(f.jobs()[0]!.state).toBe('done')
  const row = f.rows()[0]!
  const audit = f.audits()
  const appended = f.input(2), old = f.input().payload.platformQueries![0]!.relations![0]!
  appended.payload.platformQueries![0]!.relations = [{ ...old, sequenceNo: 2 }]
  const next = commitRosterImport(f.db, appended); await whenIdle()
  expect(next.candidateTaskIds).not.toEqual(first.candidateTaskIds)
  const job = f.jobs().at(-1)!
  expect(job.state).toBe('done')
  const result = job.result as AnnualTaskResult
  expect(result.events[0]).toMatchObject({ status: 'done', finalQualification: { status: 'blocked', reasons: ['protected_decision'] } })
  expect(result.events[0]!.outcomes[0]).toMatchObject({ status: 'protected', decisionRefs: [{ id: row.id, status }] })
  expect(f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id, row.id)).get()).toMatchObject({ status })
  expect(f.audits().filter(a => a.correspondenceId === row.id)).toEqual(audit.filter(a => a.correspondenceId === row.id))
})

it('queued annual cancellation wins over repeated archive dispatch', async () => {
  const f = fixture()
  const activate = annual.activateAnnualCorrespondence
  const spy = vi.spyOn(annual, 'activateAnnualCorrespondence').mockImplementation((db, read, ids, filesDir) => {
    for (const id of ids) expect(requestJobCancel(db, id)).toMatchObject({ state: 'cancelled' })
    activate(db, read, ids, filesDir)
  })
  const receipt = commitRosterImport(f.db, f.input()); await whenIdle()
  expect(spy).toHaveBeenCalledOnce()
  const job = f.jobs()[0]!
  expect(job).toMatchObject({ state: 'cancelled', progress: { done: 0, total: 1 } })
  const before = f.audits()
  activateCandidateDiscoveryTasks(f.db, receipt.candidateTaskIds, f.dir)
  activate(f.db, readAnnualWriteScope, [job.id], f.dir); await whenIdle()
  expect(f.audits()).toEqual(before)
  expect(f.rows().every(row => row.status === 'candidate')).toBe(true)
})

it('candidate cancellation prevents annual admission until explicit checkpoint retry', async () => {
  const f = fixture(2)
  const receipt = commitRosterImport(f.db, f.input())
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(f.rows()).toHaveLength(1)
  expect(requestJobCancel(f.db, receipt.candidateTaskIds[0]!)).toMatchObject({ cancelRequested: true })
  await whenIdle()
  expect(getJob(f.db, receipt.candidateTaskIds[0]!)?.state).toBe('cancelled')
  expect(f.jobs()).toEqual([])
  const before = f.audits()
  retryCandidateDiscovery(f.db, receipt.candidateTaskIds[0]!, f.dir); await whenIdle()
  expectAnnualDone(f, f.events.map(e => e.id), 1)
  expect(f.audits().filter(row => before.some(old => old.id === row.id))).toEqual(before)
})

it('explicit event and title candidate discovery do not expand into automatic annual tasks', async () => {
  const f = fixture()
  submitCandidateDiscovery(f.db, { eventIds: [f.events[0]!.id], clientRequestId: 'synthetic-explicit' }, f.dir)
  submitCandidateDiscovery(f.db, { titleCode: 'specialized_sme', clientRequestId: 'synthetic-title' }, f.dir)
  await whenIdle()
  expect(f.jobs()).toEqual([])
})

it('empty affected scopes stage no annual job and preserve unrelated large archives', async () => {
  const f = fixture()
  const body = f.input()
  body.payload.platformQueries![0]!.queryKey = '91330211790043112T'
  body.payload.platformQueries![0]!.relations = []
  body.payload.platformQueries![0]!.rawResponse = 'unrelated-large-archive:' + 'x'.repeat(5 * 1024 * 1024)
  const receipt = commitRosterImport(f.db, body); await whenIdle()
  expect(getJob(f.db, receipt.candidateTaskIds[0]!)).toMatchObject({ state: 'done', result: { items: [] } })
  expect(f.jobs()).toEqual([])
  expect(f.rows()).toEqual([])
})

it('annual staging uses the bounded reader and retains real oversized-source failures in both task lanes', async () => {
  const f = fixture(), input = f.input()
  input.payload.platformQueries![0]!.rawResponse = 'affected-large-archive:' + 'x'.repeat(4 * 1024 * 1024)
  const original = annual.stageAnnualCorrespondence
  const statements: string[] = []
  const stage = vi.spyOn(annual, 'stageAnnualCorrespondence').mockImplementation((db, read, raw) => {
    expect(f.db.$client.inTransaction).toBe(true)
    const prepare = f.db.$client.prepare.bind(f.db.$client)
    const driver = vi.spyOn(f.db.$client, 'prepare').mockImplementation(((statement: string) => { statements.push(statement); return prepare(statement) }) as typeof f.db.$client.prepare)
    try { return original(db, read, raw) } finally { driver.mockRestore() }
  })
  const receipt = commitRosterImport(f.db, input); await whenIdle()
  expect(stage).toHaveBeenCalledOnce()
  expect(statements.join('\n')).not.toMatch(/raw_response|canonical_raw_json/)
  expect(getJob(f.db, receipt.candidateTaskIds[0]!)).toMatchObject({ state: 'failed', result: { items: [{ errorCode: 'source_materialization_limit' }] } })
  expect(f.jobs()).toHaveLength(1)
  expect(f.jobs()[0]).toMatchObject({ state: 'failed', result: { attempt: 1, events: [{ status: 'failed', errorCode: 'source_materialization_limit' }] } })
  expect(f.rows()).toEqual([]); expect(f.audits()).toEqual([])
})

it('recovers committed annual jobs after SIGKILL before activation', async () => {
  const childDir = process.env.ARCHIVE_ANNUAL_259_CRASH_DIR
  if (childDir) {
    const f = fixture(1, childDir)
    // Actual SQLite/reader/stage/runner execute unchanged. Inject process death
    // only at the post-commit activation boundary, before enqueue can occur.
    vi.spyOn(annual, 'activateAnnualCorrespondence').mockImplementation((db, _read, ids) => {
      expect(f.db.$client.inTransaction).toBe(false)
      expect(getJob(db, ids[0]!)?.state).toBe('queued')
      writeFileSync(join(childDir, 'committed.json'), JSON.stringify({ annualId: ids[0], eventId: f.events[0]!.id, audit: f.audits() }))
      process.kill(process.pid, 'SIGKILL')
    })
    commitRosterImport(f.db, f.input())
    await whenIdle()
    throw Error('SIGKILL boundary was not reached')
  }
  const dir = mkdtempSync(join(tmpdir(), 'archive-annual-259-crash-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const vitest = join(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs')
  const child = spawn(process.execPath, [vitest, 'run', 'tests/archive-annual-correspondence.test.ts', '-t', 'recovers committed annual jobs after SIGKILL before activation', '--maxWorkers=1'], {
    cwd: process.cwd(), env: { ...process.env, ARCHIVE_ANNUAL_259_CRASH_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: Buffer[] = []
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk))
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  cleanups.push(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL') })
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timeout)
  expect(code).not.toBe(0)
  expect(Buffer.concat(output).toString()).toContain('Worker exited unexpectedly')
  const checkpoint = JSON.parse(readFileSync(join(dir, 'committed.json'), 'utf8')) as { annualId: string; eventId: number; audit: unknown[] }
  const db = drizzle(new Database(join(dir, 'synthetic.db')), { schema: s })
  cleanups.push(() => db.$client.close())
  expect(getJob(db, checkpoint.annualId)).toMatchObject({ state: 'queued', progress: { done: 0, total: 1 } })
  expect(annual.initializeAnnualCorrespondenceRunner(db, readAnnualWriteScope)).toBe(2)
  expect(getJob(db, checkpoint.annualId)?.state).toBe('failed')
  const candidate = db.select().from(s.job).where(eq(s.job.kind, 'event-archive-candidates')).get()!
  retryCandidateDiscovery(db, candidate.id, dir); await whenIdle()
  expect(db.select().from(s.job).where(eq(s.job.kind, ANNUAL_CORRESPONDENCE_KIND)).all()).toHaveLength(1)
  // Candidate replay must not silently reopen the failed annual task.
  expect(getJob(db, checkpoint.annualId)?.state).toBe('failed')
  expect(db.select().from(s.recordCorrespondenceAudit).all()).toEqual(checkpoint.audit)
  annual.retryAnnualCorrespondence(db, readAnnualWriteScope, checkpoint.annualId, dir); await whenIdle()
  expect(getJob(db, checkpoint.annualId)).toMatchObject({ state: 'done', result: { attempt: 1, events: [{ eventId: checkpoint.eventId, status: 'done', finalQualification: { status: 'confirmed' } }] } })
  const audit = db.select().from(s.recordCorrespondenceAudit).all()
  annual.activateAnnualCorrespondence(db, readAnnualWriteScope, [checkpoint.annualId], dir); await whenIdle()
  expect(db.select().from(s.recordCorrespondenceAudit).all()).toEqual(audit)
}, 30_000)
