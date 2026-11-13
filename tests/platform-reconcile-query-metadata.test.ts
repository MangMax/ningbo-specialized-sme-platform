import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { initializeDb } from '../db/client'
import * as schema from '../db/schema'
import { queryPlatformSlots } from '../lib/platform/client'
import { buildPlatformWritePayload } from '../lib/platform/payload'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { whenIdle } from '../server/utils/job-runner'
import { emptyReply, platformReplay } from './helpers/platform-replay'
import type { RosterImportRequest } from '../lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'reconcile-query-metadata-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
const queriedAt = '2026-11-13T00:00:00.000Z'
const now = () => new Date('2026-11-13T04:00:00.000Z')
afterEach(async () => { await whenIdle(); vi.unstubAllEnvs() })
afterAll(() => {
  if (process.env.RECONCILE_769_EVIDENCE) writeFileSync(join(process.env.RECONCILE_769_EVIDENCE, 'synthetic-regressions.json'), JSON.stringify({
    queries: db.select().from(schema.platformQuery).all(),
    receipts: db.select().from(schema.importReceipt).all(),
  }, null, 2))
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function target(uscc: string) {
  const enterprise = db.insert(schema.enterprise).values({ name: uscc, nameNorm: uscc, usccNorm: uscc }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
  return { id: enterprise.id, name: uscc, uscc }
}

async function seedSlots(uscc: string, slots: { interface: 'business_list' | 'apply_list'; rdjb: '' | '1' | '2' | '3'; titleCode: string | null }[]) {
  const replay = platformReplay(emptyReply)
  const queries = []
  for (const slot of slots) {
    const [outcome] = await queryPlatformSlots({ uscc, cookie: 'offline=fixture', fetchImpl: replay.fetchImpl, retries: 0, now: () => queriedAt },
      slot.interface === 'apply_list' ? [{ interface: 'apply_list' }] : slot.rdjb === '' ? [] : [{ interface: 'business_list', rdjb: slot.rdjb }])
    if (!outcome) throw new Error('Missing local fixture outcome')
    queries.push({ ...slot, queryKey: uscc, queriedAt, outcome })
  }
  const request = buildPlatformWritePayload({ sourceIdentity: 'query-metadata-test', idempotencyKey: `seed:${uscc}`, queries, enterprises: [] })
  expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
  expect(commitRosterImport(db, request, [], { deferCandidateTasks: true }).status).toBe('committed')
}

function requests(uscc: string) {
  return db.select().from(schema.importReceipt).all().map(row => JSON.parse(row.requestBody) as RosterImportRequest)
    .filter(row => row.sourceIdentity === 'platform/reconcile:specialized_sme' && row.payload.platformQueries?.some(q => q.queryKey === uscc))
}

it('retains every stored nonNULL title even when rdjb differs and ordinary wrong-title replay still rejects', async () => {
  const uscc = '91330211000000769A'
  target(uscc)
  await seedSlots(uscc, [
    { interface: 'business_list', rdjb: '1', titleCode: 'little_giant' },
    { interface: 'business_list', rdjb: '2', titleCode: 'innovative_sme' },
    { interface: 'business_list', rdjb: '3', titleCode: 'specialized_sme' },
    { interface: 'apply_list', rdjb: '', titleCode: 'little_giant' },
  ])
  const fetchImpl = vi.fn(async () => { throw new Error('Reused slots must not fetch') })
  vi.stubEnv('MIIT_COOKIE', '')
  const report = await runPlatformReconcile({ db, usccs: [uscc], titles: ['specialized_sme'], now, cookie: null, fetchImpl })
  expect(report.write?.status).toBe('committed')
  expect(report.queries).toMatchObject({ network: 0, reused: 4 })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(requests(uscc).slice(-1)[0]!.payload.platformQueries!.map(q => [q.rdjb, q.titleCode]))
    .toEqual([['1', 'little_giant'], ['2', 'innovative_sme'], ['3', 'specialized_sme'], ['', 'little_giant']])
  const wrong: RosterImportRequest = {
    sourceIdentity: 'negative-query-title', sourceKind: 'platform_archive', idempotencyKey: 'negative-query-title',
    payload: { platformQueries: [{ interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt, titleCode: 'innovative_sme', relations: [] }] },
  }
  expect(preflightRosterImport(db, wrong).preflight.conflicts.map(item => item.error)).toEqual([{
    code: 'query_payload_conflict', field: 'titleCode', message: 'Existing query has different titleCode; use the actual new observation time',
  }])
  expect(commitRosterImport(db, wrong).status).toBe('failed')
})

it('mixes original NULL and mismatched reused titles with fresh business rdjb mapping and fresh apply NULL', async () => {
  const uscc = '91330211000000769B'
  target(uscc)
  await seedSlots(uscc, [
    { interface: 'business_list', rdjb: '1', titleCode: 'little_giant' },
    { interface: 'business_list', rdjb: '2', titleCode: null },
  ])
  const replay = platformReplay(emptyReply)
  const report = await runPlatformReconcile({ db, usccs: [uscc], titles: ['specialized_sme'], now, cookie: 'offline=fixture', retries: 0, fetchImpl: replay.fetchImpl })
  expect(report.write?.status).toBe('committed')
  expect(report.queries).toEqual({ network: 2, reused: 2, byInterface: { business_list: 1, apply_list: 1 } })
  expect(replay.calls).toEqual([{ uscc, interface: 'business_list', rdjb: '3' }, { uscc, interface: 'apply_list', rdjb: '' }])
  expect(requests(uscc).slice(-1)[0]!.payload.platformQueries!.map(q => [q.rdjb, q.titleCode, q.queriedAt]))
    .toEqual([['1', 'little_giant', queriedAt], ['2', null, queriedAt], ['3', 'little_giant', now().toISOString()], ['', null, now().toISOString()]])
})

it('freshly fetched business titles retain all three rdjb mappings and apply stays NULL', async () => {
  const uscc = '91330211000000769C'
  target(uscc)
  const replay = platformReplay(emptyReply)
  const report = await runPlatformReconcile({ db, usccs: [uscc], titles: ['specialized_sme'], now, cookie: 'offline=fixture', retries: 0, fetchImpl: replay.fetchImpl })
  expect(report.write?.status).toBe('committed')
  expect(report.queries).toEqual({ network: 4, reused: 0, byInterface: { business_list: 3, apply_list: 1 } })
  expect(requests(uscc).slice(-1)[0]!.payload.platformQueries!.map(q => [q.rdjb, q.titleCode]))
    .toEqual([['1', 'innovative_sme'], ['2', 'specialized_sme'], ['3', 'little_giant'], ['', null]])
  expect(replay.calls).toHaveLength(4)
})
