import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import { createRosterImportClient, type RosterImportRequest, type RosterImportUsccBackfill } from '../../../layers/sme-roster/lib/roster-import-client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { startPostgresImportHttp } from './fixtures/postgres-import-http'

const dir = mkdtempSync(join(tmpdir(), 'uscc-backfill-'))
const TOKEN = 'isolated-uscc-backfill'
const targetName = '宁波统代补录目标有限公司'
const targetUscc = '913302017133602847'
const availableUscc = '913302067562827060'
const heldUscc = '91330211255994457P'
const source = {
  url: 'https://example.gov.cn/notice/1',
  checkedOn: '2026-10-16',
  basis: '公开名录中名称与信用代码、注册地均一致',
  name: targetName,
  region: '宁波市/镇海区',
}

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let server: Awaited<ReturnType<typeof startPostgresImportHttp>> | undefined
let db: ReturnType<typeof usePostgresDirectoryDb>
let client: ReturnType<typeof createRosterImportClient>
let targetId: number, availableId: number, holderId: number

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  const targets = await db.insert(enterprise).values([
    { name: targetName, nameNorm: targetName, district: '镇海区', city: '宁波市', qualityFlags: '["uscc_missing"]' },
    { name: '宁波另一待查企业有限公司', nameNorm: '宁波另一待查企业有限公司', city: '宁波市', district: '镇海区' },
    { name: '宁波有统代企业有限公司', nameNorm: '宁波有统代企业有限公司', usccNorm: heldUscc },
  ]).returning({ id: enterprise.id })
  ;[targetId, availableId, holderId] = targets.map(row => row.id) as [number, number, number]
  await db.insert(record).values({ enterpriseId: targetId, source: 'jxj', titleCode: 'specialized_sme', district: '镇海区' })
  server = await startPostgresImportHttp(dir, TOKEN)
  client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
}, 60_000)

afterAll(async () => {
  await server?.close()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function request(key: string, ...usccBackfills: RosterImportUsccBackfill[]): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/public-uscc', payload: { usccBackfills } }
}

it('publishes a source-backed plan, commits the missing credit code and returns the same result on replay', async () => {
  const route = server!.baseUrl + '/api/roster/uscc-research'
  const response = await fetch(route, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enterpriseIds: [targetId], claims: [{ enterpriseId: targetId, uscc: targetUscc, source }] }),
  })
  const { plan } = await response.json()
  expect(response.status, JSON.stringify(plan)).toBe(200)
  expect(plan.request.payload.usccBackfills).toMatchObject([{ enterpriseId: targetId, uscc: targetUscc, source }])
  const result = await client.commit(plan.request)
  expect(result).toMatchObject({ status: 'committed', summary: { written: 1 }, items: [{
    kind: 'uscc_backfill', ok: true, detail: { lineage: { enterpriseId: targetId, uscc: targetUscc, previousUscc: null, source } },
  }] })
  expect(await client.commit(plan.request)).toEqual(result)
  const [target] = await db.select().from(enterprise).where(eq(enterprise.id, targetId))
  expect(target).toMatchObject({ usccNorm: targetUscc, qualityFlags: '[]' })
  const checklist = await fetch(route + '?q=' + encodeURIComponent(targetName))
  expect(checklist.status).toBe(200)
  expect((await checklist.json()).checklist.rows).toEqual([])
})

it.each([
  { code: 'uscc_taken', input: () => ({ enterpriseId: availableId, uscc: heldUscc, source }) },
  { code: 'uscc_already_present', input: () => ({ enterpriseId: holderId, uscc: availableUscc, source }) },
  { code: 'uscc_format_invalid', input: () => ({ enterpriseId: availableId, uscc: '91330211255994457Q', source }) },
  { code: 'source_evidence_incomplete', input: () => ({ enterpriseId: availableId, uscc: availableUscc, source: { ...source, basis: '' } }) },
  { code: 'enterprise_selector_conflict', input: () => ({ enterpriseId: availableId, enterpriseName: targetName, uscc: availableUscc, source }) },
])('fails the whole credit-code submission on $code', async ({ code, input }) => {
  const before = await db.select().from(enterprise).orderBy(enterprise.id)
  const result = await client.commit(request(code, { enterpriseId: availableId, uscc: availableUscc, source }, input()))
  expect(result).toMatchObject({ status: 'failed', summary: { written: 0 },
    items: expect.arrayContaining([expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })]),
  })
  expect(await db.select().from(enterprise).orderBy(enterprise.id)).toEqual(before)
})
