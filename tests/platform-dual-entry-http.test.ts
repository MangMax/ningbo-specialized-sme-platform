import { it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createRouter, toNodeListener, defineEventHandler, setHeader, getQuery, getRouterParam, createError, readBody, getHeader, setResponseStatus } from 'h3'
import { sql } from 'drizzle-orm'
import { initializeDb } from '../db/client'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import type { RosterImportRequest, RosterImportPlatformQuery } from '../lib/roster-import-client'

it('normal replay and retained relationId repair expose the same literal fields without changing archived identities', async () => {
  const retained = process.env.ACCEPTANCE_598_DIR
  const dir = retained ?? mkdtempSync(join(tmpdir(), 'dual-entry-598-'))
  const dbPath = join(dir, 'dual-entry.sqlite')
  if (existsSync(dbPath)) throw new Error('Acceptance requires a new empty external directory')
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  const db = initializeDb({ create: true, dbPath })
  const raw = { id: '598-controlled', qymc: '受控样本企业', rdjb: '2', sblx: '复核', year: '2024', cszt: '待审核', whpc: '2024-2', rddqrq: '原值日期' }
  const queries: RosterImportPlatformQuery[] = ['apply_list', 'business_list', 'recognized_list'].map(source => ({
    interface: source as RosterImportPlatformQuery['interface'], queryKey: 'name:受控样本企业', rdjb: '2', queriedAt: '2026-11-01T00:00:00Z', status: 'success',
    relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: raw.qymc, rawFields: raw }],
  }))
  // Recognized full-row ingestion requires the original complete queryBusList envelope.
  queries[2]!.titleCode = 'specialized_sme'
  queries[2]!.collectionEvidence = {
    source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
    queriedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z', rows: [raw], fetchedCount: 1, declaredTotal: 1,
    pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
    completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  } as never
  const request = (key: string, payload: RosterImportRequest['payload']): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/598-controlled', payload })
  for (const [key, value] of Object.entries({ defineEventHandler, setHeader, getQuery, getRouterParam, createError })) vi.stubGlobal(key, value)
  const router = createRouter()
  for (const action of ['preflight', 'commit'] as const) router.post(`/api/roster/import/${action}`, defineEventHandler(async event => {
    const out = await handleRosterImportRequest(action, { method: 'POST', headers: { authorization: getHeader(event, 'authorization') }, body: await readBody(event) }, { db, apiToken: '598-isolated-token' })
    setResponseStatus(event, out.status)
    return out.body
  }))
  for (const source of ['declarations', 'business-processes', 'recognized-directory']) {
    router.get(`/api/platform/${source}`, (await import(`../server/api/platform/${source}.get.ts`)).default)
    router.get(`/api/platform/${source}/:recordId`, (await import(`../server/api/platform/${source}/[recordId].get.ts`)).default)
  }
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const receipts: unknown[] = []
  const post = async (action: string, body: unknown) => {
    const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer 598-isolated-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const result = await response.json(); receipts.push(result); return result
  }
  const snapshot = () => Object.fromEntries(['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'enterprise', 'record', 'record_event', 'enterprise_alias', 'record_correspondence', 'difference_reason'].map(table => [table, db.all(sql.raw(`SELECT * FROM ${table} ORDER BY rowid`))]))
  const check = async () => {
    for (const [source, expected] of [
      ['declarations', { declarationYear: 2024, status: '待审核', declareKind: 'review', titleRaw: '2' }],
      ['business-processes', { businessYear: 2024, status: '待审核', declareKind: 'review', titleRaw: '2' }],
      ['recognized-directory', { titleRaw: '2', validityDateRaw: '原值日期', maintenanceBatch: '2024-2', maintenanceYear: null, district: null, awardNote: null }],
    ] as const) {
      const response = await fetch(`${base}/api/platform/${source}`)
      expect(response.status).toBe(200)
      const list = await response.json()
      expect(list.total).toBe(1)
      expect(list.rows[0].matchedVersion).toMatchObject(expected)
      expect(list.rows[0].matchedVersion.ruleVersion).toBeTruthy()
      const detail = await (await fetch(`${base}/api/platform/${source}/${list.rows[0].record.id}`)).json()
      expect(detail.versions).toHaveLength(1)
      expect(detail.versions[0]).toMatchObject(expected)
    }
  }
  try {
    const seed = request('598-seed', { platformQueries: queries })
    expect((await post('preflight', seed)).preflight.conflicts).toEqual([])
    expect((await post('commit', seed)).summary.platformFields).toMatchObject({ status: 'ready', eligibleVersions: 3, projectionsChecked: 3 })
    await check()
    const before = snapshot()
    // A consistent backup precedes deliberate historical-gap construction in this isolated database.
    await db.$client.backup(join(dir, 'before-gap.sqlite'))
    const erase = () => { for (const table of ['platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection']) db.run(sql.raw(`DELETE FROM ${table}`)) }
    erase()
    expect((await post('commit', request('598-normal-repair', { platformQueries: queries }))).summary.platformFields).toMatchObject({ status: 'ready', projectionsCreated: 3 })
    await check(); expect(snapshot()).toEqual(before)
    erase()
    const ids = db.all<{ id: number }>(sql`SELECT id FROM platform_relation ORDER BY id`)
    const repair = request('598-maintenance', { platformRecordObservations: ids.map(({ id }) => ({ relationId: id })) })
    expect((await post('preflight', repair)).preflight.conflicts).toEqual([])
    const receipt = await post('commit', repair)
    expect(receipt.status).toBe('committed')
    await check(); expect(snapshot()).toEqual(before)
    expect(await post('commit', repair)).toEqual(receipt)
    expect(snapshot()).toEqual(before)
    if (retained) writeFileSync(join(dir, 'receipts.json'), JSON.stringify({ raw, queries, receipts, invariantSnapshot: before }, null, 2))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
    if (!retained) rmSync(dir, { recursive: true, force: true })
  }
})
