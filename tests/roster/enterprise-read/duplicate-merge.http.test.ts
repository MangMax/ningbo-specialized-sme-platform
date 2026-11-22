import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { rosterLegacyMember } from '../../../db/postgresql/roster-selection-tables'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import type { DuplicateMergeReport } from '../../../layers/sme-roster/lib/roster/duplicate-merge'
import { createRosterImportClient, RosterImportApiError, type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { minimalPdf } from '../../support/minimal-pdf'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { startPostgresImportHttp } from './fixtures/postgres-import-http'

const dir = mkdtempSync(join(tmpdir(), 'duplicate-merge-http-'))
const token = 'isolated-duplicate-merge'
const name = '宁波同名待核机械有限公司'
const uscc = '91330211255994457P'
const request: RosterImportRequest = {
  idempotencyKey: 'synthetic-duplicate-award',
  sourceKind: 'announcement',
  sourceIdentity: 'synthetic/recognition.pdf',
  payload: {
    announcement: {
      sourceDocument: { source: 'jxj', title: '合成认定名单' },
      records: [{
        enterprise: { name, uscc, district: '镇海区' },
        titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2023, batchSeq: 2, decidedYear: 2023,
          evidence: [{ sourceFile: 'synthetic/recognition.pdf', attachment: '名单', listNo: 5, page: 1 }] }],
      }],
    },
  },
}

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let server: Awaited<ReturnType<typeof startPostgresImportHttp>> | undefined
let db: ReturnType<typeof usePostgresDirectoryDb>
let existing: number

beforeAll(async () => {
  mkdirSync(join(dir, 'synthetic'))
  writeFileSync(join(dir, 'synthetic/recognition.pdf'), minimalPdf({ pages: 1 }))
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  const [subject] = await db.insert(enterprise).values({ name, nameNorm: name, district: '镇海区' }).returning()
  existing = subject!.id
  await db.insert(rosterLegacyMember).values({ enterpriseId: existing })
  const [before] = await db.insert(record).values({ enterpriseId: existing, source: 'jxj', titleCode: 'specialized_sme', nameRaw: name }).returning()
  const [award] = await db.insert(recordEvent).values({ recordId: before!.id, eventType: 'award', year: 2022, decidedYear: 2022 }).returning()
  await db.insert(recordEvidence).values({ recordEventId: award!.id, sourceFile: 'synthetic/announcement.pdf', listNo: 74, page: 74 })
  server = await startPostgresImportHttp(dir, token)
}, 60_000)

afterAll(async () => {
  await server?.close()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

it('requires evidence before merging same-name subjects and preserves both announcements on a replayable commit', async () => {
  const client = createRosterImportClient({ baseUrl: server!.baseUrl, token })
  const report = async (): Promise<DuplicateMergeReport> => {
    const query = new URLSearchParams({ batchKey: request.idempotencyKey })
    const response = await fetch(server!.baseUrl + '/api/roster/import/duplicate-candidates?' + query)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }

  const preflight = await client.preflight(request)
  expect(preflight.preflight.duplicateCandidates).toMatchObject([{ name, existingEnterpriseId: existing, newEnterpriseId: null, newUscc: uscc }])
  expect(await db.select().from(enterprise).where(eq(enterprise.usccNorm, uscc))).toEqual([])

  const stage = await client.commit({ ...request, idempotencyKey: request.idempotencyKey + '-reviewed' })
  expect(stage.status).toBe('staged')
  if (stage.status !== 'staged') throw new Error('Expected staged announcement')
  const review = { sourceDigest: stage.sourceDigest, basis: '核对新统代主体和公布条目',
    rows: [{ action: 'create' as const, fields: { name, uscc } }] }
  const reviewed = await client.preflightSupplement(stage.intakeId, review).catch(error => {
    if (error instanceof RosterImportApiError) throw new Error(JSON.stringify(error.body), { cause: error })
    throw error
  })
  const committed = await client.supplement(stage.intakeId, { ...review, officialEvidencePlanHash: reviewed.officialEvidencePlanHash })
  expect(committed.status).toBe('supplemented')
  const [canonical] = await db.select().from(enterprise).where(eq(enterprise.usccNorm, uscc))
  const withoutEvidence = await report()
  expect(withoutEvidence).toMatchObject({ counts: { candidates: 1, pending: 1, ready: 0 }, request: null,
    pending: [{ candidate: { existingEnterpriseId: existing, newEnterpriseId: null }, reason: 'no_platform_query' }],
  })

  await seedPostgresPlatformQuery(db, {
    interface: 'business_list', queryKey: uscc, rdjb: '2', status: 'success', queriedAt: '2026-10-19T00:00:00Z',
    rawResponse: 'Synthetic verified business source',
    relations: [{ sequenceNo: 1, enterpriseId: canonical!.id, relationKey: 'synthetic-same-name', usccRaw: uscc, nameRaw: name,
      rawFields: { id: 'synthetic-same-name', tyshxydm: uscc, qymc: name } }],
  })
  const withEvidence = await report()
  expect(withEvidence).toMatchObject({ counts: { candidates: 1, pending: 0, ready: 1 },
    request: { payload: { merges: [{ fromEnterpriseId: existing, intoUscc: uscc }] } },
  })
  const merged = await client.commit(withEvidence.request!)
  expect(merged).toMatchObject({ status: 'committed', summary: { failed: 0 }, items: [{
    kind: 'merge', ok: true, detail: { lineage: { fromEnterpriseId: existing, intoEnterpriseId: canonical!.id } },
  }] })
  expect(await client.commit(withEvidence.request!)).toEqual(merged)

  const list = await listPostgresRosterEnterprises(db, { q: name })
  expect(list.rows.map(row => row.enterpriseId)).toEqual([canonical!.id])
  const detail = await readPostgresRosterEnterpriseDetail(db, existing)
  expect(detail?.evidence.map(row => [row.sourceFile, row.listNo, row.page])).toEqual([
    ['synthetic/announcement.pdf', 74, 74], ['synthetic/recognition.pdf', 5, 1],
  ])
  expect(detail?.aliases).toEqual([])
  expect((await report()).previous).toMatchObject({ idempotencyKey: withEvidence.request!.idempotencyKey })
})
