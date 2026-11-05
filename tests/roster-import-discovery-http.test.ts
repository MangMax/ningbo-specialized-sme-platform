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
import { getPlatformExportRows, listPlatformSnapshots } from '../lib/platform-snapshots'

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

it('preserves alias core required-field errors and commits normalized aliases with exact readback and replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue315b-alias-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve('db/migrations') })
  for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
  const api = await startRosterApi({ db, apiToken: 'synthetic-315b', executeImport: async (database, action, request, errors, context) => action === 'preflight' ? preflightRosterImport(database, request, errors, context) : commitRosterImport(database, request, errors, context) })
  async function post(action: string, key: string, payload: unknown) {
    const response = await fetch(`${api.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-315b', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: key, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic-alias-notice', payload }) })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    // Create the owner through the public import seam, not a fixture-only database insert.
    const owner = await post('commit', 'alias-owner', { announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic alias owner' }, records: [{ enterprise: { name: '别名发现归属企业' }, titleCode: 'specialized_sme' }] } })
    expect(owner.status).toBe('committed')
    const rows = listEnterprises(db, { q: '别名发现归属企业' }).rows
    expect(rows).toHaveLength(1)
    const enterpriseId = rows[0]!.enterpriseId
    const valid = { enterpriseName: '别名发现归属企业', name: '  旧称企业  ', sourceKind: 'manual', sourceRefId: 0.9, validFrom: null, note: 7, extra: { raw: null } }
    const invalidCases = [
      { alias: { ...valid, name: undefined }, error: { code: 'alias_name_required', field: 'aliases[].name', message: '别名缺少 name' } },
      { alias: { ...valid, sourceKind: undefined }, error: { code: 'alias_source_kind_unknown', field: 'sourceKind', message: 'sourceKind 不在字典内：undefined' } },
      { alias: { ...valid, enterpriseName: undefined }, error: { code: 'enterprise_not_found', field: 'enterpriseName', message: '别名找不到归属企业：(空)' } },
      { alias: { ...valid, sourceRefId: undefined, sourceRelationRef: { queryKey: 'synthetic-query' } }, error: { code: 'ref_interface_unknown', field: 'aliases[].sourceRelationRef.interface', message: '引用缺少 interface 或取值不在字典内：undefined' } },
      { alias: { ...valid, sourceRefId: undefined, sourceRelationRef: { interface: 'business_list' } }, error: { code: 'ref_query_key_required', field: 'aliases[].sourceRelationRef.queryKey', message: '引用缺少 queryKey' } },
      { alias: { ...valid, sourceRefId: undefined, sourceRelationRef: { interface: 'business_list', queryKey: 'synthetic-query', relationKey: 'key-alone' } }, error: { code: 'ref_sequence_no_required', field: 'aliases[].sourceRelationRef.sequenceNo', message: '关系引用缺少 sequenceNo（同一次查询内第几条，从 1 起）' } },
    ]
    for (const [index, { alias, error }] of invalidCases.entries()) {
      // JSON roundtrip represents actual transport omission, not JS undefined properties.
      const payload = JSON.parse(JSON.stringify({ aliases: [alias] }))
      const key = `alias-invalid-${index}`
      const before = await post('preflight', key, payload)
      expect(before.preflight.conflicts).toEqual([{ ok: false, kind: 'alias', ref: 'alias:0', error }])
      expect(await post('preflight', key, rosterImportMcpPayloadSchema.parse(payload))).toEqual(before)
      expect(getRosterEnterpriseDetail(db, enterpriseId)!.aliases).toEqual([])
    }
    const payload = { aliases: [valid], extra: null }
    const before = await post('preflight', 'alias-valid', payload)
    expect(before.preflight.conflicts).toEqual([])
    expect(await post('preflight', 'alias-valid', rosterImportMcpPayloadSchema.parse(payload))).toEqual(before)
    const saved = await post('commit', 'alias-valid', rosterImportMcpPayloadSchema.parse(payload))
    expect(saved.status).toBe('committed')
    expect(await post('commit', 'alias-valid', payload)).toEqual(saved)
    const aliases = getRosterEnterpriseDetail(db, enterpriseId)!.aliases
    expect(aliases).toEqual([{ id: expect.any(Number), name: '旧称企业', nameNorm: '旧称企业', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending', validFrom: null, validTo: null, note: null }])
    expect(readImportBatchOutcome(db, 'alias-valid')).toMatchObject({ status: 'committed', items: saved.items, summary: saved.summary })
    const withdrawn = await post('commit', 'alias-withdrawn', rosterImportMcpPayloadSchema.parse({ aliases: [{ ...valid, name: '撤回别名', verificationStatus: 'withdrawn' }] }))
    expect(withdrawn.status).toBe('committed')
    expect(getRosterEnterpriseDetail(db, enterpriseId)!.aliases).toEqual(expect.arrayContaining([expect.objectContaining({ name: '撤回别名', verificationStatus: 'withdrawn' })]))
  } finally {
    await api.close()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('preserves snapshot core required-field errors and legacy numeric normalization with exact readback and replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue315b-export-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve('db/migrations') })
  for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
  const api = await startRosterApi({ db, apiToken: 'synthetic-315b', executeImport: async (database, action, request, errors, context) => action === 'preflight' ? preflightRosterImport(database, request, errors, context) : commitRosterImport(database, request, errors, context) })
  async function post(action: string, key: string, payload: unknown) {
    const response = await fetch(`${api.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-315b', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: key, sourceKind: 'platform_export', sourceIdentity: 'synthetic-export', payload }) })
    expect(response.status).toBe(200)
    return response.json()
  }
  const snapshot = { titleCode: 'specialized_sme', year: 2026.9, collectedOn: '2026-11-05', originalFilename: 'synthetic.xlsx', sha256: 'legacy-nonempty-identity', rows: [{ sourceRowNo: 3.9, nameRaw: '  快照测试企业  ', usccRaw: null, district: null, rawFields: { preserved: null }, extra: true }] }
  try {
    for (const field of ['titleCode', 'year', 'collectedOn', 'originalFilename', 'sha256', 'sourceRowNo']) {
      const invalid = JSON.parse(JSON.stringify(snapshot))
      if (field === 'sourceRowNo') delete invalid.rows[0].sourceRowNo
      else delete invalid[field]
      const payload = { exportSnapshot: invalid }
      const expected = field === 'titleCode'
        ? { kind: 'export_batch', ref: 'export:snapshot', error: { code: 'title_unknown', field: 'titleCode', message: '称号不在字典内：undefined' } }
        : field === 'sourceRowNo'
          ? { kind: 'export_row', ref: 'export:row:0', error: { code: 'source_row_no_required', field: 'rows[].sourceRowNo', message: '快照行缺少 sourceRowNo' } }
          : { kind: 'export_batch', ref: 'export:snapshot', error: { code: 'export_identity_incomplete', field: 'exportSnapshot', message: '快照缺少 year / collectedOn / originalFilename / sha256' } }
      const before = await post('preflight', `export-invalid-${field}`, payload)
      expect(before.preflight.conflicts).toEqual([{ ok: false, ...expected }])
      expect(await post('preflight', `export-invalid-${field}`, rosterImportMcpPayloadSchema.parse(payload))).toEqual(before)
      expect(listPlatformSnapshots(db)).toEqual([])
    }
    const payload = { exportSnapshot: snapshot }
    const original = await post('preflight', 'export-valid', payload)
    expect(original.preflight.conflicts).toEqual([])
    expect(await post('preflight', 'export-valid', rosterImportMcpPayloadSchema.parse(payload))).toEqual(original)
    const saved = await post('commit', 'export-valid', rosterImportMcpPayloadSchema.parse(payload))
    expect(saved.status).toBe('committed')
    expect(await post('commit', 'export-valid', payload)).toEqual(saved)
    const batches = listPlatformSnapshots(db)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.batch).toMatchObject({ titleCode: 'specialized_sme', year: 2026.9, collectedOn: '2026-11-05', originalFilename: 'synthetic.xlsx', sha256: 'legacy-nonempty-identity', rowCount: 1 })
    expect(getPlatformExportRows(db, batches[0]!.batch.id)).toEqual([{ sourceRowNo: 3, nameRaw: '快照测试企业', usccRaw: null, district: null, province: null, city: null, regStatus: null }])
    // Rows are optional at the actual core seam, despite the client TS interface.
    const omittedRows = { ...snapshot, sha256: 'legacy-empty-snapshot', rows: undefined }
    const empty = await post('preflight', 'export-empty', JSON.parse(JSON.stringify({ exportSnapshot: omittedRows })))
    expect(empty.preflight.conflicts).toEqual([])
  } finally {
    await api.close()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
