import { finishFixtureAnnouncement } from './fixtures/reviewed-announcement'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { rosterImportMcpPayloadSchema } from '../../../layers/sme-roster/server/utils/roster-import-schema'
import { commitRosterImport, preflightRosterImport, readImportBatchOutcome } from '../../../layers/sme-roster/server/utils/roster-import'
import { startRosterApi } from './fixtures/import-server'
import { listEnterprises } from '../../../layers/sme-roster/server/utils/mcp-roster'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'
import { saveDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import { listPlatformQueries } from '../../../layers/sme-roster/lib/platform/read'

async function fixture(run: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), '315remaining-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  const db = drizzle(sqlite, { schema })
  sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
  const api = await startRosterApi({ db, apiToken: 'synthetic', executeImport: async (database, action, request, errors, context) => action === 'preflight' ? preflightRosterImport(database, request, errors, context) : commitRosterImport(database, request, errors, context) })
  let serial = 0
  async function post(action: string, key: string, payload: unknown, sourceKind = 'alias_evidence') {
    const body = { idempotencyKey: key, sourceKind, sourceIdentity: 'synthetic-315remaining', payload } as RosterImportRequest
    const response = await fetch(`${api.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const result = await response.json()
    if (result.status !== 'staged') return result
    const receipt = await finishFixtureAnnouncement(api.baseUrl, 'synthetic', db, body, result)
    return { ...receipt, status: receipt.status === 'supplemented' ? 'committed' : receipt.status }
  }
  async function invalid(payload: unknown, code: string, field: string) {
    const key = `invalid-${serial++}`
    const p = JSON.parse(JSON.stringify(payload))
    const result = await post('preflight', key, rosterImportMcpPayloadSchema.parse(p))
    expect(result.preflight.conflicts, JSON.stringify(result.preflight.conflicts)).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code, field }) })])
    expect(await post('preflight', key, p)).toEqual(result)
    const failed = await post('commit', key, p)
    expect(failed.status).toBe('failed')
    expect(failed.items).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: expect.objectContaining({ code, field }) })]))
  }
  async function saved(key: string, payload: unknown, sourceKind = 'alias_evidence') {
    const p = JSON.parse(JSON.stringify(payload))
    const preview = await post('preflight', key, rosterImportMcpPayloadSchema.parse(p), sourceKind)
    expect(preview.preflight.conflicts).toEqual([])
    const result = await post('commit', key, rosterImportMcpPayloadSchema.parse(p), sourceKind)
    expect(result.status, JSON.stringify(result.items)).toBe('committed')
    expect(await post('commit', key, p, sourceKind)).toEqual(result)
    expect(readImportBatchOutcome(db, key)).toMatchObject({ status: 'committed', items: result.items, summary: result.summary })
    return result
  }
  async function owner(name: string, uscc?: string) {
    await saved(`owner-${serial++}`, { announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic owner' }, records: [{ enterprise: { name, uscc }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, evidence: [{ sourceFile: 'synthetic.pdf', page: 2 }] }] }] } }, 'announcement')
    return listEnterprises(db, { q: name }).rows.find((row: any) => row.name === name)?.enterpriseId ?? listEnterprises(db, { q: name }).rows[0]!.enterpriseId
  }
  try { await run({ db, post, invalid, saved, owner }) } finally { await api.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('rejects fractional source coordinates and keeps native source sentinels and immutable replay through public HTTP core', () => fixture(async ({ db, invalid, saved }) => {
  const query = { interface: 'apply_list', queryKey: 'legacy-key', queriedAt: '2026-11-05', status: 'success', rawResponse: '{original}', relations: [{ sequenceNo: 1, nameRaw: '  原行企业  ', year: 2026, declareKind: 'legacy-value', rawFields: { unknown: null } }] }
  for (const [field, code] of [['interface', 'interface_unknown'], ['queryKey', 'query_key_required'], ['queriedAt', 'queried_at_required']] as const) await invalid({ platformQueries: [{ ...query, [field]: undefined }] }, code, field)
  await invalid({ platformQueries: [{ ...query, relations: [{}] }] }, 'sequence_no_required', 'relations[].sequenceNo')
  await invalid({ platformQueries: [{ ...query, status: 'bad' }] }, 'query_status_unknown', 'status')
  await invalid({ platformQueries: [{ ...query, reuseExisting: false }] }, 'query_reuse_invalid', 'reuseExisting')
  await invalid({ platformQueries: [{ interface: 'recognized_list', queryKey: 'x', queriedAt: '2026-11-05' }] }, 'collection_evidence_invalid', 'collectionEvidence')
  await invalid({ platformQueries: [{ ...query, relations: [{ ...query.relations[0], sequenceNo: 3.9, year: 2026.9 }] }] }, 'sequence_no_invalid', 'relations[].sequenceNo')
  await invalid({ platformQueries: [{ ...query, relations: [{ ...query.relations[0], year: 2026.9 }] }] }, 'year_invalid', 'relations[].year')
  expect(listPlatformQueries(db).rows).toEqual([])
  await saved('legacy-query', { platformQueries: [query] })
  const read = () => listPlatformQueries(db, { includeRawResponse: true }).rows
  expect(read()).toHaveLength(1)
  expect(read()[0]).toMatchObject({ query: { interface: 'apply_list', queryKey: 'legacy-key', rawResponse: '{original}', collectionEvidence: null }, relations: [{ sequenceNo: 1, nameRaw: '原行企业', year: 2026, declareKind: 'legacy-value', rawFields: { unknown: null } }] })
  const before = read()
  for (const [i, rawResponse] of [undefined, null].entries()) await saved(`sentinel-${i}`, { platformQueries: [{ interface: 'apply_list', queryKey: 'legacy-key', queriedAt: '2026-11-05', rawResponse, reuseExisting: true }] })
  expect(read()).toEqual(before)
  await invalid({ platformQueries: [{ interface: 'apply_list', queryKey: 'legacy-key', queriedAt: '2026-11-05', rawResponse: 'null' }] }, 'query_payload_conflict', 'rawResponse')
  expect(read()).toEqual(before)
}))

it('archives all three typed collection sources with literal raw readback and rejects version position completeness and source mismatches', () => fixture(async ({ db, invalid, saved }) => {
  for (const [source, iface, grid] of [['queryList', 'apply_list', 'applyGrid'], ['businessList', 'business_list', 'businessListGrid'], ['queryBusList', 'recognized_list', 'businessGrid']]) {
    const raw = { id: `row-${source}`, qymc: '原行企业', tyshxydm: '91330211255994457P', n: 1, b: false, x: null, arr: [null, 2] }
    const row = { id: raw.id, qymc: raw.qymc, tyshxydm: raw.tyshxydm, n: '1', b: 'false', x: '', arr: '[null,2]' }
    const rdjb = source === 'queryList' ? null : '2'
    const pos = { source, rdjb, page: 1 }
    const body = JSON.stringify({ zrarData: { grid: { [grid!]: { pageSet: [raw], page: 1, pageSize: 1, maxCount: 1, maxPage: 1 } } } })
    const evidence = { source, status: 'success', effectiveConditions: { uscc: raw.tyshxydm, combination: 'and' }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: rdjb ? [rdjb] : [] }, queriedAt: '2026-11-05T00:00:00Z', completedAt: '2026-11-05T00:00:01Z', rows: [row], rawData: { version: 1, rows: [raw], pages: [{ ...pos, format: 'json', body }] }, pages: [{ ...pos, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 1, maxDurationMs: 1000, pageSize: 1 } }
    const query = { interface: iface, queryKey: raw.tyshxydm, queriedAt: evidence.queriedAt, rdjb: rdjb ?? '', titleCode: rdjb ? 'specialized_sme' : null, status: 'success', collectionEvidence: evidence, relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: raw.qymc, usccRaw: raw.tyshxydm, rawFields: raw }] }
    for (const change of [ { rawData: { ...evidence.rawData, version: 2 } }, { pages: [{ ...evidence.pages[0], source: 'wrong' }] }, { completeness: 'partial' }, { source: 'wrong' } ]) await invalid({ platformQueries: [{ ...query, collectionEvidence: { ...evidence, ...change } }] }, 'collection_evidence_invalid', 'collectionEvidence')
    await saved(`typed-${source}`, { platformQueries: [query] })
    const archived = listPlatformQueries(db, { interface: iface as any, includeRawResponse: true }).rows
    expect(archived).toHaveLength(1)
    expect(archived[0]!.query.collectionEvidence).toEqual(evidence)
    expect(archived[0]!.relations[0]).toMatchObject({ sequenceNo: 1, relationKey: raw.id, rawFields: raw })
    await saved(`typed-reference-${source}`, { platformQueries: [{ interface: iface, queryKey: raw.tyshxydm, queriedAt: evidence.queriedAt, rdjb: rdjb ?? '', reuseExisting: true }] })
    expect(listPlatformQueries(db, { interface: iface as any, includeRawResponse: true }).rows).toEqual(archived)
  }
}))

it('preserves difference required fields pending review and normalized decision readback with replay', () => fixture(async ({ db, owner, invalid, saved }) => {
  const id = await owner('差异归属企业')
  const difference = { enterpriseName: '差异归属企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2026-11-05', status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed', reasonNote: '  原因  ', movedIn: { city: '  宁波  ', year: 2020.9, batch: 2.9 } }
  for (const [field, code] of [['titleCode', 'title_unknown'], ['direction', 'direction_unknown'], ['recordedAt', 'recorded_at_required'], ['enterpriseName', 'enterprise_not_found']] as const) await invalid({ differences: [{ ...difference, [field]: undefined }] }, code, field)
  await invalid({ differences: [{ ...difference, measureCode: 'none' }] }, 'pending_review_decision_invalid', 'reasonCode')
  await invalid({ differences: [{ ...difference, evidenceQueryId: 1, evidenceQueryRef: { interface: 'apply_list', queryKey: 'x' } }] }, 'evidence_ref_conflict', 'differences[].evidenceQueryRef')
  expect(getRosterEnterpriseDetail(db, id)!.differences).toEqual([expect.objectContaining({ explanationId: null, recordedAt: null, status: 'not_queried' })])
  await saved('difference-valid', { differences: [difference] })
  const rows = getRosterEnterpriseDetail(db, id)!.differences
  expect(rows).toHaveLength(1)
  expect(rows[0]!).toMatchObject({ titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2026-11-05', status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed', reasonNote: '原因', movedIn: { city: '宁波', year: 2020, batch: 2 } })
  // Setup uses the existing lifecycle command owner; the rejection under test is public HTTP/core.
  saveDecision102(db, { enterpriseId: id, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: rows[0]!.explanationId, idempotencyKey: 'lifecycle-setup', actor: { type: 'agent', id: 'synthetic' }, basis: 'explicit review', ruleVersion: 'manual-1', effectiveAt: '2026-11-05T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed' } })
  const managed = getRosterEnterpriseDetail(db, id, Date.parse('2026-11-05'))!.differences
  await invalid({ differences: [{ ...difference, recordedAt: '2026-11-06' }] }, 'decision_lifecycle_required', 'differences')
  expect(getRosterEnterpriseDetail(db, id, Date.parse('2026-11-05'))!.differences).toEqual(managed)

}))

it('backfills only missing codes with source selector errors exact lineage and idempotent readback', () => fixture(async ({ db, owner, invalid, saved }) => {
  const id = await owner('补录企业')
  const other = await owner('占用企业', '91330211255994457P')
  const source = { url: ' https://example.com/content ', checkedOn: '2026-11-05', basis: ' 名称地区一致 ', name: '补录企业', region: null }
  const backfill = { enterpriseId: id + 0.9, uscc: '913302017133602847', source, note: null }
  await invalid({ usccBackfills: [{ ...backfill, uscc: undefined }] }, 'uscc_format_invalid', 'uscc')
  for (const field of ['url', 'checkedOn', 'basis', 'name']) await invalid({ usccBackfills: [{ ...backfill, source: { ...source, [field]: undefined } }] }, 'source_evidence_incomplete', 'source')
  await invalid({ usccBackfills: [{ ...backfill, enterpriseId: undefined }] }, 'enterprise_required', 'enterpriseId')
  await invalid({ usccBackfills: [{ ...backfill, enterpriseName: '错误企业' }] }, 'enterprise_selector_conflict', 'enterpriseName')
  await invalid({ usccBackfills: [{ ...backfill, uscc: '91330211255994457P' }] }, 'uscc_taken', 'uscc')
  await invalid({ usccBackfills: [{ ...backfill, enterpriseId: other }] }, 'uscc_already_present', 'uscc')
  expect(getRosterEnterpriseDetail(db, id)!.enterprise.uscc).toBeNull()
  const result = await saved('backfill-valid', { usccBackfills: [backfill] })
  expect(getRosterEnterpriseDetail(db, id)!.enterprise).toMatchObject({ name: '补录企业', uscc: '913302017133602847' })
  expect(getRosterEnterpriseDetail(db, id)!.aliases).toEqual([])
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ lineage: expect.objectContaining({ enterpriseId: id, previousUscc: null, uscc: '913302017133602847', source }) }) })]))
}))

it('merges same input atomically with selector target ref and canonical name errors preserving aliases events and evidence', () => fixture(async ({ db, owner, invalid, saved }) => {
  const from = await owner('被并企业')
  const into = await owner('规范企业', '91330211255994457P')
  const merge = { fromEnterpriseId: from + 0.9, intoUscc: '91330211255994457P', canonicalName: '  规范新名  ', sourceKind: 'manual' }
  for (const [row, code, field] of [[{ ...merge, intoUscc: undefined }, 'into_uscc_required', 'intoUscc'], [{ ...merge, fromEnterpriseId: undefined }, 'merge_source_required', 'fromEnterpriseId'], [{ ...merge, intoUscc: '913302017133602847' }, 'merge_target_not_found', 'intoUscc'], [{ ...merge, canonicalName: ' ' }, 'canonical_name_invalid', 'merges[].canonicalName'], [{ ...merge, sourceRefId: 1, sourceRelationRef: {} }, 'source_ref_conflict', 'merges[].sourceRelationRef'], [{ ...merge, fromEnterpriseId: 999 }, 'merge_source_not_found', 'fromEnterpriseId'], [{ ...merge, fromEnterpriseName: '不一致' }, 'enterprise_selector_conflict', 'fromEnterpriseName'], [{ ...merge, sourceRelationRef: { interface: 'apply_list', queryKey: 'x' } }, 'ref_sequence_no_required', 'merges[].sourceRelationRef.sequenceNo']]) await invalid({ merges: [row] }, code, field)
  const before = getRosterEnterpriseDetail(db, from, Date.parse('2026-11-05'))!
  const failed = await (async () => {
    const payload = { merges: [merge], aliases: [{ enterpriseName: '不存在', name: '失败别名', sourceKind: 'manual' }] }
    await invalid(payload, 'enterprise_not_found', 'enterpriseName')
    return getRosterEnterpriseDetail(db, from, Date.parse('2026-11-05'))
  })()
  expect(failed).toEqual(before)
  const result = await saved('merge-valid', { merges: [merge] })
  expect(db.$client.prepare('SELECT id FROM enterprise WHERE id=?').get(from)).toEqual({ id: from })
  expect(db.$client.prepare('SELECT from_enterprise_id,into_enterprise_id FROM enterprise_merge WHERE from_enterprise_id=?').get(from)).toEqual({ from_enterprise_id: from, into_enterprise_id: into })
  expect(getRosterEnterpriseDetail(db, from, Date.parse('2026-11-05'))).toEqual(getRosterEnterpriseDetail(db, into, Date.parse('2026-11-05')))
  const detail = getRosterEnterpriseDetail(db, into)!
  expect(detail.enterprise).toMatchObject({ name: '规范新名', uscc: '91330211255994457P' })
  expect(detail.aliases.map((a: any) => a.name).sort()).toEqual(['被并企业', '规范企业'].sort())
  expect(detail.events).toHaveLength(2)
  expect(detail.evidence).toHaveLength(2)
  expect(detail.evidence.map((e: any) => ({ sourceFile: e.sourceFile, page: e.page }))).toEqual([{ sourceFile: 'synthetic.pdf', page: 2 }, { sourceFile: 'synthetic.pdf', page: 2 }])
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'merge', detail: expect.objectContaining({ lineage: expect.objectContaining({ fromEnterpriseId: from, intoEnterpriseId: into }) }) })]))
}))

it('resolves same batch query references and pending merge owners without losing source evidence', () => fixture(async ({ db, saved }) => {
  const ref = { interface: 'apply_list', queryKey: 'same-batch', queriedAt: '2026-11-05' }
  const result = await saved('same-batch-merge', {
    announcement: { sourceDocument: { source: 'jxj', title: 'Same batch synthetic notice' }, records: [
      { enterprise: { name: '本批来源' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, evidence: [{ sourceFile: 'source.pdf', page: 1 }] }] },
      { enterprise: { name: '本批目标', uscc: '91330211255994457P' }, titleCode: 'specialized_sme' },
    ] },
    platformQueries: [{ ...ref, status: 'success', rawResponse: 'original-body', relations: [{ sequenceNo: 1, nameRaw: '本批来源', rawFields: { original: null } }] }],
    differences: [{ enterpriseName: '本批来源', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-11-05', evidenceQueryRef: ref, evidenceRelationRef: { ...ref, sequenceNo: 1 } }],
    merges: [{ fromEnterpriseName: '本批来源', intoUscc: '91330211255994457P', sourceKind: 'manual', sourceRelationRef: { ...ref, sequenceNo: 1 }, evidenceQueryRef: ref }],
  })
  const target = listEnterprises(db, { q: '本批目标' }).rows
  expect(target).toHaveLength(1)
  expect(listEnterprises(db, { q: '本批来源' }).rows.every((row: any) => row.enterpriseId === target[0]!.enterpriseId)).toBe(true)
  const detail = getRosterEnterpriseDetail(db, target[0]!.enterpriseId)!
  const queries = listPlatformQueries(db, { includeRawResponse: true }).rows
  expect(queries).toHaveLength(1)
  expect(queries[0]!).toMatchObject({ query: { rawResponse: 'original-body' }, relations: [{ sequenceNo: 1, rawFields: { original: null } }] })
  expect(detail.aliases).toEqual([expect.objectContaining({ name: '本批来源', sourceRefId: queries[0]!.relations[0]!.id })])
  expect(detail.differences).toEqual([expect.objectContaining({ status: 'needs_review', recordedAt: '2026-11-05', evidence: expect.objectContaining({ queryId: queries[0]!.query.id, relationIds: [queries[0]!.relations[0]!.id] }) })])
  expect(detail.events).toHaveLength(1)
  expect(detail.evidence).toEqual([expect.objectContaining({ sourceFile: 'source.pdf', page: 1 })])
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'merge', detail: expect.objectContaining({ lineage: expect.objectContaining({ evidenceQueryId: queries[0]!.query.id, eventsMoved: [detail.events[0]!.id], evidenceMoved: [detail.evidence[0]!.id] }) }) })]))
}))
