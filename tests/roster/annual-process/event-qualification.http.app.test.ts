import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../../server/utils/record-correspondence'
import { readEventAnnualProcess } from '../../../server/utils/event-annual-process-read'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'annual258-wire-')), dbPath = join(dir, 'isolated.db')
const db = initializeDb({ create: true,  dbPath })
const enterprise = db.insert(s.enterprise).values({ name: '合成实际资格协议企业', nameNorm: '合成实际资格协议企业', usccNorm: '91330211255994457P' }).returning().get()
const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
const cases = [2024, 2023, 2022].map((year, n) => ({ status: ['confirmed', 'blocked', 'none'][n]!, event: db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year }).returning().get() }))
const rows = [2024, 2024, 2023].map((year, n) => {
  const key = `SQ258-${n}`, appliedAt = n === 1 ? '2024-12-13 10:00:00' : `${year}-03-01 09:00:00`
  const seeded = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-01T00:00:0${n}Z`, status: 'success', rawResponse: 'Synthetic annual HTTP source', relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: key, year, sblx: '申请', sqsj: appliedAt, cszt: n === 0 ? '终审不通过' : '终审通过' } }] })
  return { id: seeded.relationIds[0]! }
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
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_MCP_TOKEN: 'isolated258' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/_openapi.json`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function mcp(eventId: number) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer isolated258', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_event_annual_process', arguments: { eventId, pageSize: 1 } } }) })
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
