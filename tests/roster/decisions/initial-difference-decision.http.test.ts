import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb, schema } from '../../../db/client'
import { sql } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
const dir = mkdtempSync(join(tmpdir(), 'initial-274-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let server: Server, base: string
const scope = { enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const body = (key: string, expectedCurrentId: number | null = null) => ({ ...scope, action: 'replace', expectedCurrentId, idempotencyKey: key, basis: '人工核对保留公布历史', effectiveAt: '2026-10-24T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', verificationStatus: 'confirmed' } })
beforeAll(async () => {
  const sourcePath = join(dir, 'synthetic.db')
  const source = initializeDb({ create: true, dbPath: sourcePath })
  try {
    source.insert(schema.enterprise).values({ id: 1, name: '274合成', nameNorm: '274合成' }).run()
    submitNativePlatformQuery(source, { queryKey: 'name:274合成', interface: 'apply_list', rdjb: '2', status: 'success', queriedAt: '2026-10-24T00:00:00Z', rawResponse: '{"synthetic":"unaltered"}' })
  } finally { source.$client.close() }
  postgres = await postgresRuntimeFixture({ dir, sourcePath })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-only', }))
  const command = (await import('../../../layers/sme-roster/server/api/roster/evidence-review/browser-commands.post')).default
  const current = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/current.get')).default
  const history = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/history.get')).default
  const app = createApp().use('/command', command).use('/current', current).use('/history', history)
  server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 30_000)
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  postgres?.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
const post = (value: unknown) => fetch(base + '/command', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(value) })
it('first browser registration roundtrips null metadata and history while stale concurrent writes and retries preserve raw facts', async () => {
  const query = new URLSearchParams(Object.entries(scope).map(([k,v]) => [k,String(v)]))
  expect(await (await fetch(base + '/current?' + query)).json()).toMatchObject({ versionId: null, current: null })
  const first = body('first'); const ok = await post(first); expect(ok.status).toBe(200)
  const receipt = await ok.json()
  const race = await post(body('race')); expect(race.status).toBe(409); expect(await race.json()).toMatchObject({ error: { code: 'stale_version' } })
  const replay = await post(first); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt)
  expect(await (await fetch(base + '/current?' + query)).json()).toMatchObject({ versionId: receipt.versionId, current: { actor: null, ruleVersion: null, basis: first.basis, previousId: null } })
  const correction = await post(body('correction', receipt.versionId)); expect(correction.status).toBe(200)
  const history = await (await fetch(base + '/history?' + query)).json()
  expect(history.total).toBe(2); expect(history.rows[0]).toMatchObject({ previousId: receipt.versionId, actor: null, ruleVersion: null })
  const db = usePostgresDirectoryDb()
  const archive = await db.execute<{ bytes: Buffer }>(sql`
    select v.bytes from platform_archive_value v join platform_collection_archive_ref r on r.archive_id = v.id
    where r.owner_id = 1 and r.field = 'rawResponse'
  `)
  expect(archive.rows[0]!.bytes.toString()).toBe('{"synthetic":"unaltered"}')
  expect((await db.execute(sql`select * from evidence_review_receipt_114`)).rows).toHaveLength(0)
})
