import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { readEventAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-read'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'annual258-wire-')), dbPath = join(dir, 'isolated.db')
const db = initializeDb({ create: true,  dbPath })
const enterprise = db.insert(s.enterprise).values({ name: '合成实际资格协议企业', nameNorm: '合成实际资格协议企业', usccNorm: '91330211255994457P' }).returning().get()
const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
const cases = [2024, 2023, 2022].map((year, n) => ({ status: ['confirmed', 'blocked', 'none'][n]!, event: db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year }).returning().get() }))
const eligibleEvent = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021 }).returning().get()
const candidateEvent = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2020 }).returning().get()
const rows = [2024, 2024, 2023, 2021, 2020].map((year, n) => {
  const key = `SQ258-${n}`, appliedAt = n === 1 ? '2024-12-13 10:00:00' : `${year}-03-01 09:00:00`
  const seeded = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-01T00:00:0${n}Z`, status: 'success', rawResponse: 'Synthetic annual HTTP source', relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: key, year, sblx: '申请', sqsj: appliedAt, cszt: n === 0 ? '终审不通过' : '终审通过' } }] })
  return { id: seeded.relationIds[0]!, queryId: seeded.queryId }
})
let service: { baseUrl: string; stop: () => Promise<void> }
const state = () => ({ jobs: db.select().from(s.job).all(), ledger: db.select().from(s.importBatch).all(), receipts: db.select().from(s.importReceipt).all(), audit: db.select().from(s.recordCorrespondenceAudit).all(), decisions: db.select().from(s.recordCorrespondence).all() })
beforeAll(async () => {
  for (const [n, status] of ['confirmed', 'rejected'].entries()) {
    const request = { idempotencyKey: `wire258/decision-${n}`, sourceIdentity: 'tests/annual258', actor: { type: 'user' as const, id: 'fixture' }, basis: 'synthetic actual decision', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: status as 'confirmed' | 'rejected', edge: { type: 'event_process' as const, eventId: cases[n]!.event.id, relationId: rows[n + 1]!.id, role: 'context_only' as const } }] }
    commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash)
  }
  db.insert(s.job).values({ id: 'synthetic-done-wire258', kind: 'event-annual-correspondence', state: 'done', params: { eventIds: [cases[2]!.event.id] }, result: { events: [{ eventId: cases[2]!.event.id, finalQualification: { status: 'confirmed' } }] } }).run()
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_MCP_TOKEN: 'isolated258' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function mcp(eventId: number, baseUrl = service.baseUrl) {
  const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer isolated258', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_event_annual_process', arguments: { eventId, pageSize: 1 } } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
}
it.each(cases)('real query-only GET and MCP return current $status qualification without job ledger or audit writes', async ({ status, event }) => {
  const before = state(), complete = readEventAnnualProcess(db, event.id)!
  const response = await fetch(`${service.baseUrl}/api/roster/events/${event.id}/annual-process?pageSize=1`)
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json(), wire = await mcp(event.id)
  expect(wire.error).toBeUndefined(); expect(wire.result.isError).not.toBe(true)
  expect(wire.result.structuredContent).toEqual(body)
  expect(JSON.parse(wire.result.content[0].text)).toEqual(body)
  expect(body.process.finalQualification.status).toBe(status)
  expect(body.sourceGeneration).toBe(complete.sourceGeneration); expect(body.sourceRefs).toEqual(complete.sourceRefs)
  expect(body.process.latestStepSummary).toEqual(complete.process.latestStepSummary)
  if (status === 'confirmed') {
    expect(body.total).toBe(2); expect(body.process.steps[0].id).not.toBe(body.process.finalQualification.stepId)
    expect(body.process.finalQualification.decisionRefs).toMatchObject([{ relationId: rows[1]!.id, status: 'confirmed', requiresRevalidation: false }])
  } else if (status === 'blocked') expect(body.process.finalQualification.reasons).toEqual(['protected_decision'])
  else expect(body.process.finalQualification).toMatchObject({ stepId: null, reasons: ['no_annual_process'], decisionRefs: [] })
  expect(state()).toEqual(before)
})

const pgBin = process.env.TEST_IMPORT_RECEIPTS_PG_BIN
it.runIf(!!pgBin)('preserves annual reads and runs deduplicated annual and archive tasks on PostgreSQL', async () => {
  const pgDir = mkdtempSync(join(tmpdir(), 'annual-pg-'))
  const pgData = join(pgDir, 'db')
  const env = { ...process.env, PGHOST: pgDir, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: 'annual_fixture', PGSQL_BIN: join(pgBin!, 'psql') }
  const run = (name: string, args: string[]) => execFileSync(join(pgBin!, name), args, { env, stdio: 'pipe' })
  const sqliteCopy = join(pgDir, 'source.sqlite')
  let clusterStarted = false
  let child: ReturnType<typeof spawnCompiledApp> | undefined
  try {
    installLeadListSchema(db.$client)
    await db.$client.backup(sqliteCopy)
    run('initdb', ['-A', 'trust', '--locale=C', '-E', 'UTF8', '-U', env.PGUSER, '-D', pgData])
    run('pg_ctl', ['-w', '-D', pgData, '-l', join(pgDir, 'pg.log'), '-o', "-c listen_addresses='' -k " + pgDir, 'start'])
    clusterStarted = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', sqliteCopy, 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      run('psql', ['-X', '-w', '-q', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
    }
    const sqliteEmpty = join(pgDir, 'empty.sqlite')
    const companion = initializeDb({ create: true, dbPath: sqliteEmpty })
    companion.$client.close()
    const port = await reserveLoopbackPort(), baseUrl = 'http://127.0.0.1:' + port
    child = spawnCompiledApp(port, { cwd: resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NUXT_DB_PATH: sqliteEmpty, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(pgDir, 'files'),
        NUXT_INCOMING_DIR: join(pgDir, 'incoming'), NUXT_MCP_TOKEN: 'isolated258', NUXT_POSTGRES_ROSTER_READ: '1',
        NUXT_POSTGRES_JOBS: '1', NUXT_POSTGRES_DIRECTORY_WRITE: '1', NUXT_API_TOKEN: 'isolated-annual-api',
        NUXT_POSTGRES_DIRECTORY_URL: 'postgresql://annual_fixture@localhost/postgres?host=' + encodeURIComponent(pgDir) } })
    await waitForHttp(baseUrl + '/api/health', { child, timeoutMs: 60000 })
    for (const id of [...cases.map(entry => entry.event.id), eligibleEvent.id, 99999]) {
      const path = '/api/roster/events/' + id + '/annual-process?pageSize=1'
      const original = await fetch(service.baseUrl + path), migrated = await fetch(baseUrl + path)
      expect(migrated.status).toBe(original.status)
      const body = await original.json()
      expect(await migrated.json()).toEqual(body)
      if (original.ok) expect((await mcp(id, baseUrl)).result.structuredContent).toEqual(body)
    }
    const tasks = baseUrl + '/api/roster/annual-correspondence-tasks'
    const headers = { authorization: 'Bearer isolated-annual-api', 'content-type': 'application/json' }
    const eventIds = [eligibleEvent.id, cases[1]!.event.id]
    const submit = (clientRequestId: string, ids = eventIds) => fetch(tasks, {
      method: 'POST', headers, body: JSON.stringify({ clientRequestId, eventIds: ids }),
    })
    const requests = await Promise.all([submit('native-annual-1'), submit('native-annual-2')])
    for (const request of requests) expect(request.status, await request.clone().text()).toBe(202)
    const [first, duplicate] = await Promise.all(requests.map(request => request.json()))
    expect(duplicate.jobId).toBe(first.jobId)
    expect(duplicate.sourceGenerations).toEqual(first.sourceGenerations)
    expect((await submit('native-annual-1', [eligibleEvent.id])).status).toBe(409)
    let task
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(tasks + '/' + first.jobId, { headers })
      expect(response.status).toBe(200)
      task = await response.json()
      if (['done', 'failed'].includes(task.status)) break
      await delay(100)
    }
    expect(task).toMatchObject({ status: 'done', progress: { done: 2, total: 2 }, result: { attempt: 1 } })
    expect(task.result.events.find((entry: { eventId: number }) => entry.eventId === eligibleEvent.id)).toMatchObject({
      status: 'done', outcomes: [{ status: 'created', relationId: rows[3]!.id }],
      finalQualification: { status: 'confirmed', decisionRefs: [{ status: 'confirmed', relationId: rows[3]!.id }] },
    })
    expect(task.result.events.find((entry: { eventId: number }) => entry.eventId === cases[1]!.event.id)).toMatchObject({
      status: 'done', outcomes: [{ status: 'protected' }], finalQualification: { status: 'blocked', reasons: ['protected_decision'] },
    })
    const cancel = await fetch(tasks + '/' + first.jobId + '/cancel', { method: 'POST', headers })
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toMatchObject({ jobId: first.jobId, state: 'done', cancelled: false, alreadyFinished: true })

    const details = baseUrl + '/api/task-center/'
    const annualSummary = await fetch(details + first.jobId, { headers })
    expect(annualSummary.status).toBe(200)
    expect(await annualSummary.json()).toMatchObject({ annual: { total: 2, done: 2, failed: 0, unfinished: 0, attempt: 1 } })

    const candidateTasks = baseUrl + '/api/roster/correspondences/tasks'
    const explicit = { clientRequestId: 'archive-explicit-1', eventIds: [candidateEvent.id] }
    const response = await fetch(candidateTasks, { method: 'POST', headers, body: JSON.stringify(explicit) })
    expect(response.status, await response.clone().text()).toBe(202)
    const candidateJob = await response.json()
    let candidateTask
    for (let attempt = 0; attempt < 120; attempt++) {
      const detail = await fetch(details + candidateJob.jobId, { headers })
      expect(detail.status, await detail.clone().text()).toBe(200)
      candidateTask = await detail.json()
      if (['done', 'failed'].includes(candidateTask.state)) break
      await delay(100)
    }
    expect(candidateTask).toMatchObject({ state: 'done', discovery: { counts: { succeeded: 1, failed: 0 }, attempt: 1,
      items: [{ eventId: candidateEvent.id, status: 'done' }] } })
    expect(candidateTask.discovery.counts.created).toBeGreaterThan(0)
    const path = '/api/roster/events/' + candidateEvent.id + '/annual-process'
    const before = await (await fetch(baseUrl + path)).json()
    expect(before.process.finalQualification.status).toBe('eligible')

    const auto = { clientRequestId: 'archive-trigger-1', queryId: rows[4]!.queryId }
    const automatic = await fetch(candidateTasks, { method: 'POST', headers, body: JSON.stringify(auto) })
    expect(automatic.status, await automatic.clone().text()).toBe(202)
    let after
    for (let attempt = 0; attempt < 120; attempt++) {
      after = await (await fetch(baseUrl + path)).json()
      if (after.process.finalQualification.status === 'confirmed') break
      await delay(100)
    }
    expect(after.sourceGeneration).toBe(before.sourceGeneration)
    expect(after.process.finalQualification).toMatchObject({ status: 'confirmed', decisionRefs: [{ status: 'confirmed', relationId: rows[4]!.id }] })
  } finally {
    if (child) await stopOwnedChild(child)
    if (clusterStarted) run('pg_ctl', ['-w', '-m', 'fast', '-D', pgData, 'stop'])
    rmSync(pgDir, { recursive: true, force: true })
  }
}, 180000)
