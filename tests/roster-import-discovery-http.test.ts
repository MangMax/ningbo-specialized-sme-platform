import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import { rosterImportMcpPayloadSchema } from '../server/utils/roster-import-schema'
import { commitRosterImport, preflightRosterImport, readImportBatchOutcome } from '../server/utils/roster-import'
import { startRosterApi } from './helpers/roster-http-server'
import { listEnterprises } from '../server/utils/mcp-roster'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'

it('preserves legacy HTTP item errors, numeric normalization and idempotent receipts after MCP discovery parsing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue315-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve('db/migrations') })
  for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
  const api = await startRosterApi({ db, apiToken: 'synthetic-315', executeImport: async (database, action, request, errors, context) => action === 'preflight' ? preflightRosterImport(database, request, errors, context) : commitRosterImport(database, request, errors, context) })
  const envelope = { idempotencyKey: 'discovery-shadow', sourceKind: 'announcement', sourceIdentity: 'synthetic-notice' }
  const payload = { announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic notice', docNumber: null }, records: [{ enterprise: { name: '发现模型测试企业', uscc: null }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021.9, decidedYear: null, evidence: [{ sourceFile: 'synthetic.txt', page: null, extra: 'preserved' }] }] }] }, extra: { raw: null } }
  async function post(action: string, body: unknown) {
    const response = await fetch(`${api.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-315', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    const original = await post('preflight', { ...envelope, payload })
    expect(original.preflight.conflicts).toEqual([])
    expect(await post('preflight', { ...envelope, payload: rosterImportMcpPayloadSchema.parse(payload) })).toEqual(original)
    const saved = await post('commit', { ...envelope, payload: rosterImportMcpPayloadSchema.parse(payload) })
    expect(saved.status).toBe('committed')
    expect(await post('commit', { ...envelope, payload })).toEqual(saved)
    expect(readImportBatchOutcome(db, envelope.idempotencyKey)).toMatchObject({ status: 'committed', items: saved.items, summary: saved.summary })
    const enterprises = listEnterprises(db, { q: '发现模型测试企业' })
    expect(enterprises.rows).toHaveLength(1)
    const detail = getRosterEnterpriseDetail(db, enterprises.rows[0]!.enterpriseId)!
    expect(detail.events).toEqual([expect.objectContaining({ eventType: 'award', year: 2021, decidedYear: null })])

    const invalid = { announcement: { ...payload.announcement, records: [{ ...payload.announcement.records[0], titleCode: 'not-a-title' }] } }
    const invalidEnvelope = { ...envelope, idempotencyKey: 'invalid-shadow' }
    const before = await post('preflight', { ...invalidEnvelope, payload: invalid })
    expect(before.preflight.conflicts).toEqual([expect.objectContaining({ ok: false, kind: 'record', ref: 'record:0', error: { code: 'title_unknown', field: 'titleCode', message: '称号不在字典内：not-a-title' } })])
    expect(await post('preflight', { ...invalidEnvelope, payload: rosterImportMcpPayloadSchema.parse(invalid) })).toEqual(before)
  } finally {
    await api.close()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
