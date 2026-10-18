#!/usr/bin/env node
/**
 * #69 synthetic acceptance fixture and public HTTP/MCP verifier.
 *
 * --setup: exercise available API scenarios and report pending #72 qualification.
 * --fixture-only: seed and write a manifest, then stop the owned Nuxt service.
 * --serve: seed, verify the available API scenarios, and keep Nuxt alive for
 *          parent-owned desktop/390px browser acceptance (Ctrl-C to stop).
 * Default: final API acceptance; proof routes and qualification are required.
 * No application tables are read or written directly.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'
import { startIsolatedNuxt } from './lib/isolated-local-services.mjs'
import ExcelJS from 'exceljs'

const mode = process.argv.includes('--serve') ? 'serve'
  : process.argv.includes('--fixture-only') ? 'fixture-only'
    : process.argv.includes('--setup') ? 'setup' : 'acceptance'
const root = mkdtempSync(join(tmpdir(), 'spec63-acceptance-'))
const files = join(root, 'files')
const manifestPath = process.env.SPEC63_FIXTURE_MANIFEST ?? (mode === 'serve' || mode === 'fixture-only'
  ? '/tmp/spec63-acceptance-fixture.json' : join(root, 'fixture.json'))
const privatePath = join(root, 'owned-session.json')
const apiToken = randomBytes(32).toString('hex')
const mcpToken = randomBytes(32).toString('hex')
const nonce = randomBytes(8).toString('hex')
const sourceFile = `jxj/announcement/2024/1/spec63-${nonce}.pdf`
const report = { mode, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim(),
  fixture: root, checks: [], pending: [], lanes: {
    api: { status: 'running', checks: 0, blockers: [] },
    browser: { status: 'not_run', owner: 'parent', scope: 'desktop, 390px, URL/back/scroll, PDF arrival, focus, and UI review' },
    production: { status: 'not_run', reason: 'synthetic isolated fixture only' },
  } }
let service
let base
let fixture

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function checked(name, fn) { return Promise.resolve().then(fn).then(() => { report.checks.push(name); console.log(`✓ ${name}`) }) }
function uscc(number) {
  // Synthetic valid checksum, with a fixed local-only prefix and changing body.
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY'
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]
  const stem = `91330200${String(number).padStart(9, '0')}`
  const sum = [...stem].reduce((total, char, i) => total + alphabet.indexOf(char) * weights[i], 0)
  return stem + alphabet[(31 - sum % 31) % 31]
}
const person = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((letter, index) => [letter, {
  name: `宁波六三合成${letter}企业有限公司`, uscc: uscc(index + 1),
}]))
const T = { specialized: 'specialized_sme', innovative: 'innovative_sme' }
const timestamp = (minute) => `2026-10-18T02:${String(minute).padStart(2, '0')}:00.000Z`
const queryKey = (name) => encodeURIComponent(name)

async function request(method, path, body, { auth = false, token = apiToken, allow = [200] } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const raw = await response.text()
  let value
  try { value = JSON.parse(raw) } catch { value = raw }
  if (!allow.includes(response.status)) throw new Error(`${method} ${path} returned ${response.status}: ${raw.slice(0, 700).replaceAll(apiToken, '[token]').replaceAll(mcpToken, '[token]')}`)
  if (response.ok && path.startsWith('/api/roster/correspondences')) assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  return { status: response.status, value, raw }
}
const get = async (path, options) => (await request('GET', path, undefined, options)).value
const post = async (path, body, options = {}) => (await request('POST', path, body, { auth: true, ...options })).value

async function importBatch(label, sourceKind, sourceIdentity, payload, sourceSha256) {
  const input = { idempotencyKey: `spec63-${nonce}-${label}`, sourceKind, sourceIdentity, ...(sourceSha256 ? { sourceSha256 } : {}), payload }
  const preview = await post('/api/roster/import/preflight', input)
  assert.deepEqual(preview.preflight?.conflicts ?? [], [], `${label} import preflight`)
  const committed = await post('/api/roster/import/commit', input)
  assert.equal(committed.status, 'committed', `${label} import status: ${JSON.stringify(committed).slice(0, 1200)}`)
  assert.equal(committed.summary?.failed, 0, `${label} failed rows`)
  return committed
}
function detail(item, kind, index = 0) {
  const found = item.items.filter(row => row.kind === kind)[index]
  assert.ok(found?.detail, `${kind}[${index}] missing in import receipt`)
  return found.detail
}
function queryId(item, index = 0) {
  const ref = item.items.filter(row => row.kind === 'platform_query')[index]?.ref
  assert.match(ref ?? '', /^query:\d+$/)
  return Number(ref.slice(6))
}
function exportId(item) {
  const ref = item.items.find(row => row.kind === 'export_batch')?.ref
  assert.match(ref ?? '', /^export:\d+$/)
  return Number(ref.slice(7))
}
function businessRow(letter, sequenceNo, props = {}) {
  return { sequenceNo, relationKey: props.relationKey ?? `S63-${letter}-${sequenceNo}`,
    usccRaw: person[letter].uscc, nameRaw: person[letter].name,
    matchBasis: 'uscc', verificationStatus: 'confirmed', year: props.year ?? 2024,
    batch: props.batch ?? '1', declareKind: props.declareKind ?? 'apply',
    status: props.status ?? '已通过', appliedAt: props.appliedAt ?? '2024-04-01',
    rawFields: { synthetic: true, originalStatus: props.status ?? '已通过' }, ...props }
}
function archivedRecognized(letter, minute, { status = 'success', rows = 1, fullRange = true, rdjb = ['2'] } = {}) {
  const rawRows = Array.from({ length: rows }, (_, index) => ({ id: `S63-rec-${letter}-${minute}-${index + 1}`, qymc: person[letter].name, tyshxydm: person[letter].uscc, whpcyear: '2024', whpc: '1', rddqrq: '2027' }))
  const page = { source: 'queryBusList', rdjb: rdjb[0], page: 1, fetchedCount: rows,
    status: 'success', declaredTotal: rows, maxPage: 1, error: null }
  const evidence = { source: 'queryBusList', status: rows ? status : 'no_record', effectiveConditions: { uscc: person[letter].uscc, combination: 'and' },
    titleScope: { mode: 'selected', rdjb }, queriedAt: timestamp(minute), completedAt: timestamp(minute + 1),
    rows: rawRows, pages: [page], fetchedCount: rows, declaredTotal: rows,
    completeness: 'complete', fullRange, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 } }
  return { interface: 'recognized_list', queryKey: person[letter].uscc, rdjb: rdjb.join(','),
    titleCode: rdjb.length === 1 ? T.specialized : null, queriedAt: evidence.queriedAt,
    status: rows ? 'success' : 'no_record', collectionEvidence: evidence,
    relations: rawRows.map((rawFields, index) => ({ sequenceNo: index + 1, relationKey: rawFields.id,
      usccRaw: rawFields.tyshxydm, nameRaw: rawFields.qymc, rawFields })) }
}

async function seed() {
  mkdirSync(dirname(join(files, sourceFile)), { recursive: true })
  const pdf = minimalPdf({ pages: 3 })
  writeFileSync(join(files, sourceFile), pdf)
  const file = await post('/api/files/register', { relPath: sourceFile, source: 'jxj', kind: 'announcement', year: '2024', batch: '1' }, { allow: [200, 201] })
  assert.equal(file.sha256, sha256(pdf), 'formal stored-file hash must come from registration API')
  const ev = (eventType, year, listNo, other = {}) => ({ eventType, year, batchSeq: 1, ...other,
    evidence: [{ sourceFile, attachment: '合成附件一', listNo, page: listNo % 3 + 1 }] })
  const records = [
    { enterprise: person.A, titleCode: T.specialized, events: [ev('award', 2021, 1)] },
    { enterprise: person.B, titleCode: T.specialized, events: [ev('award', 2024, 2)] },
    { enterprise: person.C, titleCode: T.specialized, events: [ev('award', 2021, 3), ev('review', 2021, 4, { decidedYear: 2024, reviewOutcome: 'failed' })] },
    { enterprise: person.D, titleCode: T.specialized, events: [ev('award', 2022, 5), ev('award', 2024, 6, { batchSeq: 2 })] },
    { enterprise: person.D, titleCode: T.innovative, events: [ev('award', 2023, 7)] },
    { enterprise: person.E, titleCode: T.specialized, events: [ev('award', 2024, 8)] },
    { enterprise: person.F, titleCode: T.specialized, events: [ev('award', 2024, 9)] },
    { enterprise: person.G, titleCode: T.specialized, events: [ev('award', null, 10, { batchSeq: null })] },
    { enterprise: person.H, titleCode: T.specialized, events: [ev('award', 2024, 11)] },
  ]
  const formal = await importBatch('formal', 'announcement', sourceFile, { announcement: {
    sourceDocument: { source: 'jxj', title: '六三号合成验收三页公告', docNumber: `S63-${nonce}`, issueDate: '2024-10-18' }, records,
  } }, file.sha256)
  const officialDocumentId = detail(formal, 'record_event').sourceDocumentId
  const events = {}
  const enterprises = {}
  const formalRows = formal.items.filter(row => row.kind === 'record_event')
  assert.equal(formalRows.length, records.length)
  for (let index = 0; index < records.length; index++) {
    const key = index === 3 ? 'D2022' : index === 4 ? 'Dinnovative' : index === 5 ? 'E' : index === 6 ? 'F' : index === 7 ? 'G' : index === 8 ? 'H' : ['A', 'B', 'C'][index]
    const data = formalRows[index].detail
    enterprises[key] = data.enterpriseId
    events[key] = data.events
  }
  const queries = [
    { interface: 'business_list', queryKey: person.A.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(0), status: 'success', relations: [businessRow('A', 1, { year: 2021, status: '已通过', appliedAt: '2021-04-01' })] },
    { interface: 'apply_list', queryKey: person.A.uscc, rdjb: '', titleCode: T.specialized, queriedAt: timestamp(2), status: 'success', relations: [businessRow('A', 1, { year: 2025, status: '退回', declareKind: 'update' })] },
    { interface: 'business_list', queryKey: person.B.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(4), status: 'success', relations: [businessRow('B', 1, { year: 2024, status: '待审核' })] },
    { interface: 'business_list', queryKey: person.C.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(6), status: 'success', relations: [businessRow('C', 1, { year: 2024, declareKind: 'review', status: '终审不通过' })] },
    { interface: 'apply_list', queryKey: person.C.uscc, rdjb: '', titleCode: T.specialized, queriedAt: timestamp(8), status: 'success', relations: [businessRow('C', 1, { year: 2025, declareKind: 'apply', status: '待审核' })] },
    { interface: 'business_list', queryKey: person.D.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(10), status: 'success', relations: Array.from({ length: 6 }, (_, i) => businessRow('D', i + 1, { year: i < 3 ? 2022 : 2024, relationKey: `S63-D-duplicate-${i % 2}` })) },
    { interface: 'apply_list', queryKey: person.D.uscc, rdjb: '', titleCode: T.innovative, queriedAt: timestamp(12), status: 'success', relations: [businessRow('D', 1, { year: 2023 }), businessRow('D', 2, { year: 2023 })] },
    archivedRecognized('E', 14),
    { interface: 'business_list', queryKey: person.F.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(16), status: 'partial', relations: [businessRow('F', 1, { year: 2024 })] },
    archivedRecognized('F', 18, { rows: 0 }),
    { interface: 'apply_list', queryKey: person.F.uscc, rdjb: '', titleCode: T.innovative, queriedAt: timestamp(20), status: 'failed', failureReason: 'synthetic auth_failed', relations: [] },
    { interface: 'business_list', queryKey: `name:${person.G.name}`, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(22), status: 'success', relations: [
      { sequenceNo: 1, relationKey: 'S63-G-unknown', usccRaw: null, nameRaw: person.G.name, matchBasis: 'none', verificationStatus: 'pending', status: '待审核', year: null },
      { sequenceNo: 2, relationKey: 'S63-G-conflict', usccRaw: person.H.uscc, nameRaw: person.G.name, matchBasis: 'none', verificationStatus: 'pending', status: '待审核', year: null },
    ] },
    { interface: 'business_list', queryKey: person.H.uscc, rdjb: '2', titleCode: T.specialized, queriedAt: timestamp(26), status: 'success',
      relations: Array.from({ length: 7 }, (_, index) => businessRow('H', index + 1)) },
  ]
  const imported = await importBatch('platform-rows', 'alias_evidence', `synthetic/platform/${nonce}`, { platformQueries: queries })
  const queryIds = queries.map((_, index) => queryId(imported, index))
  const relations = queries.map((_, index) => detail(imported, 'platform_query', index).relations)
  async function registeredExport(label, rowNo, name) {
    const path = `miit/export/2026/1/spec63-${label}-${nonce}.xlsx`
    mkdirSync(dirname(join(files, path)), { recursive: true })
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('synthetic')
    sheet.addRow(['source_row_no', 'uscc', 'name', 'status'])
    sheet.addRow([rowNo, person.E.uscc, name, label])
    writeFileSync(join(files, path), Buffer.from(await workbook.xlsx.writeBuffer()))
    const stored = await post('/api/files/register', { relPath: path, source: 'miit', kind: 'export', year: '2026', batch: '1' }, { allow: [200, 201] })
    assert.equal(stored.sha256, sha256(Buffer.from(await (await fetch(`${base}/api/files/${path}`)).arrayBuffer())))
    return { path, ...stored }
  }
  const conflictingName = '宁波六三合成E旧名企业有限公司'
  const exportFiles = [await registeredExport('v1', 7, conflictingName), await registeredExport('v2', 9, person.E.name)]
  const exportOld = await importBatch('export-v1', 'platform_export', exportFiles[0].path, { exportSnapshot: {
    titleCode: T.specialized, year: 2026, collectedOn: '2026-10-18', originalFilename: `synthetic-v1-${nonce}.xlsx`,
    sha256: exportFiles[0].sha256, rows: [{ sourceRowNo: 7, usccRaw: person.E.uscc, nameRaw: conflictingName, rawFields: { synthetic: true, status: '在册' } }],
  } }, exportFiles[0].sha256)
  const exportNew = await importBatch('export-v2', 'platform_export', exportFiles[1].path, { exportSnapshot: {
    titleCode: T.specialized, year: 2026, collectedOn: '2026-10-18', originalFilename: `synthetic-v2-${nonce}.xlsx`,
    sha256: exportFiles[1].sha256, rows: [{ sourceRowNo: 9, usccRaw: person.E.uscc, nameRaw: person.E.name, rawFields: { synthetic: true, status: '在册', sourceVersion: 2 } }],
  } }, exportFiles[1].sha256)
  const broad = archivedRecognized('E', 24)
  broad.queryKey = `synthetic-full-title-${nonce}`
  broad.collectionEvidence.effectiveConditions = { combination: 'and' }
  const broadRequest = { idempotencyKey: `spec63-${nonce}-recognized-full-title`, sourceKind: 'alias_evidence',
    sourceIdentity: `synthetic/full-title/${nonce}`, payload: { platformQueries: [broad] } }
  const broadPreview = await post('/api/roster/import/preflight', broadRequest)
  const broadConflicts = broadPreview.preflight?.conflicts ?? []
  let broadQueryId = null
  let broadRelationId = null
  if (!broadConflicts.length) {
    const saved = await post('/api/roster/import/commit', broadRequest)
    assert.equal(saved.status, 'committed')
    broadQueryId = queryId(saved)
    broadRelationId = detail(saved, 'platform_query').relations[0]
  }
  return { nonce, sourceFile, file: { id: file.id, sha256: file.sha256, bytes: file.bytes }, edgeIds: {},
    officialDocumentId, enterprises, events, queryIds, relations,
    exportBatches: [exportId(exportOld), exportId(exportNew)],
    exportRows: [detail(exportOld, 'export_batch').rows[0], detail(exportNew, 'export_batch').rows[0]],
    exportFiles: exportFiles.map(file => ({ id: file.id, path: file.path, sha256: file.sha256 })),
    broadArchive: { queryId: broadQueryId, relationId: broadRelationId, conflicts: broadConflicts },
    uscc: Object.fromEntries(Object.entries(person).map(([key, value]) => [key, value.uscc])) }
}

function comparisonPath(ids = fixture.queryIds, batches = fixture.exportBatches, proofs = []) {
  const params = new URLSearchParams({ mode: 'record', queryIds: ids.join(','), exportBatchIds: batches.join(','),
    officialSourceDocumentIds: String(fixture.officialDocumentId) })
  if (proofs.length) params.set('proofIds', proofs.join(','))
  return `/comparison?${params}`
}
function compareQuery(proofs = []) { return comparisonPath(fixture.queryIds, fixture.exportBatches, proofs).replace('/comparison?mode=record', '/api/roster/record-comparison?') }
function decision(label, operations, proofIds) { return { idempotencyKey: `spec63-${nonce}-edge-${label}`, sourceIdentity: fixture.sourceFile,
  actor: { type: 'agent', id: 'synthetic-acceptance' }, basis: `Synthetic row evidence for ${label}`, ruleId: 'manual-row-review', ruleVersion: '1',
  ...(proofIds ? { proofIds } : {}), operations } }
function create(edge, status = 'confirmed') { return { action: 'create', status, edge } }
async function decide(label, operations, transport = 'rest', proofIds) {
  const input = decision(label, operations, proofIds)
  const planned = transport === 'mcp' ? await mcpCall('preflight_record_correspondences', input, true) : await post('/api/roster/correspondences/preflight', input)
  assert.match(planned.planHash, /^[0-9a-f]{64}$/)
  const committed = transport === 'mcp' ? await mcpCall('save_record_correspondences', { request: input, planHash: planned.planHash }, true)
    : await post('/api/roster/correspondences/commit', { request: input, planHash: planned.planHash })
  assert.deepEqual(committed.impact, planned.impact)
  return { input, planned, committed }
}
let rpcId = 0
async function mcpRpc(method, params, auth = false) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(auth ? { authorization: `Bearer ${mcpToken}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  const raw = await response.text()
  assert.equal(response.status, 200, `MCP ${method} HTTP ${response.status}: ${raw.slice(0, 400)}`)
  const line = raw.startsWith('event:') ? raw.split('\n').find(text => text.startsWith('data: '))?.slice(6) : raw
  const rpc = JSON.parse(line)
  assert.ok(!rpc.error, `MCP ${method}: ${JSON.stringify(rpc.error)}`)
  return rpc.result
}
async function mcpCall(name, args, auth = false) {
  const result = await mcpRpc('tools/call', { name, arguments: args }, auth)
  assert.ok(!result.isError, `MCP ${name}: ${JSON.stringify(result.content).slice(0, 500)}`)
  return JSON.parse(result.content[0].text)
}

async function verifyAvailable() {
  const f = fixture
  await checked('formal PDF registration, hash, and page 3 provenance', async () => {
    const event = await get(`/api/roster/correspondences/events/${f.events.C[1]}`)
    assert.equal(event.source.id, f.events.C[1])
    assert.equal(event.source.officialEvidence[0].storedFile.id, f.file.id)
    assert.equal(event.source.officialEvidence[0].storedFile.sha256, f.file.sha256)
    assert.equal(event.source.evidence[0].page, 2)
    const pdf = await fetch(`${base}/api/files/${f.sourceFile}`)
    assert.equal(pdf.status, 200)
    assert.equal(sha256(Buffer.from(await pdf.arrayBuffer())), f.file.sha256)
  })
  await checked('scenario 1: 2021 award stays aligned beside 2025 returned update', async () => {
    const written = await decide('award-and-later', [
      create({ type: 'event_process', eventId: f.events.A[0], relationId: f.relations[0][0], role: 'supports_award' }),
      create({ type: 'later_process', enterpriseId: f.enterprises.A, titleCode: T.specialized, predecessorEventId: f.events.A[0], relationId: f.relations[1][0], role: 'followup_update' }),
    ])
    f.edgeIds.awardA = written.committed.correspondenceIds[0]
    const result = await get(compareQuery())
    const row = result.rows.find(item => item.event.id === f.events.A[0])
    assert.equal(row.classification, 'historical_aligned')
    assert.ok(row.laterProcesses.some(item => item.relation.id === f.relations[1][0]))
    assert.equal(result.currentSourceConsistency.qualification, 'not_comparable')
  })
  await checked('scenario 2: same-batch pending row conflicts with formal award', async () => {
    await decide('same-batch-pending', [create({ type: 'event_process', eventId: f.events.B[0], relationId: f.relations[2][0], role: 'context_only' })])
    const result = await get(compareQuery())
    const row = result.rows.find(item => item.event.id === f.events.B[0])
    assert.equal(row.classification, 'historical_conflict')
    assert.ok(row.platformRows.some(item => item.id === f.relations[2][0] && item.status === '待审核'))
  })
  await checked('scenario 3: review original 2021 and decision 2024 remain separate from new application 2025', async () => {
    await decide('review-and-new-application', [
      create({ type: 'event_process', eventId: f.events.C[1], relationId: f.relations[3][0], role: 'supports_review' }),
      create({ type: 'later_process', enterpriseId: f.enterprises.C, titleCode: T.specialized, predecessorEventId: f.events.C[1], relationId: f.relations[4][0], role: 'followup_apply' }),
    ])
    const result = await get(compareQuery())
    const review = result.rows.find(item => item.event.id === f.events.C[1])
    assert.equal(review.event.year, 2021)
    assert.equal(review.event.decidedYear, 2024)
    assert.equal(review.classification, 'historical_aligned')
    assert.ok(review.laterProcesses.some(item => item.relation.id === f.relations[4][0]))
  })
  await checked('scenario 4: two titles and repeated relation keys preserve row identity', async () => {
    const six = await get(`/api/platform/queries?queryKey=${queryKey(person.D.uscc)}&pageSize=50`)
    const business = six.rows.find(item => item.query.id === f.queryIds[5])
    assert.equal(business.relations.length, 6)
    assert.equal(new Set(business.relations.map(item => item.id)).size, 6)
    assert.equal(new Set(business.relations.map(item => item.relationKey)).size, 2)
    assert.equal(six.rows.find(item => item.query.id === f.queryIds[6]).relations.length, 2)
    const wrong = await request('POST', '/api/roster/correspondences/preflight', decision('cross-title', [create({ type: 'event_process', eventId: f.events.Dinnovative[0], relationId: f.relations[5][0], role: 'context_only' })]), { auth: true, allow: [422] })
    assert.equal(wrong.value.error.code, 'title_conflict')
  })
  await checked('scenario 5 setup: recognized and two export versions retain original row IDs; no proof means not comparable', async () => {
    const source = await get(`/api/roster/correspondences/relations/${f.relations[7][0]}`)
    assert.equal(source.source.query.interface, 'recognized_list')
    assert.equal(source.source.sourceRdjb, '2')
    const result = await get(compareQuery())
    assert.equal(result.currentSourceConsistency.qualification, 'not_comparable')
    assert.ok(result.currentSourceConsistency.recognizedObservations.some(item => item.recognized.id === f.relations[7][0] && item.exportRows.some(row => row.id === f.exportRows[1])))
    const candidate = await decide('recognized-export-candidate', [create({ type: 'recognized_export', relationId: f.relations[7][0],
      exportRowId: f.exportRows[1], role: 'same_current_row' }, 'candidate')])
    f.edgeIds.recognizedExportCandidate = candidate.committed.correspondenceIds[0]
    const promote = await request('POST', '/api/roster/correspondences/preflight', decision('recognized-export-without-proof', [
      { action: 'decide', correspondenceId: f.edgeIds.recognizedExportCandidate, expectedRevision: 1, status: 'confirmed' },
    ]), { auth: true, allow: [422] })
    assert.equal(promote.value.error.code, 'incomplete_coverage')
  })
  await checked('scenario 6: partial, complete zero, and failed query stay distinct', async () => {
    const result = await get(compareQuery())
    const statuses = new Map(result.coverage.map(item => [item.queryId, item.status]))
    assert.equal(statuses.get(f.queryIds[8]), 'partial')
    assert.equal(statuses.get(f.queryIds[9]), 'no_record')
    assert.equal(statuses.get(f.queryIds[10]), 'failed')
    const zero = await get(`/api/platform/queries?queryKey=${queryKey(person.F.uscc)}&interface=recognized_list`)
    assert.equal(zero.rows[0].relations.length, 0)
    assert.equal(result.rows.find(item => item.event.id === f.events.F[0]).classification, 'official_without_correspondence')
    assert.equal(result.officialCoverage.qualification, 'unknown')
  })
  await checked('scenario 7: unknown identity remains pending and cannot be confirmed by same name', async () => {
    const candidates = await post('/api/roster/correspondences/candidates', { eventId: f.events.G[0], queryIds: [f.queryIds[11]], exportBatchIds: [], ruleVersion: '1' })
    assert.equal(candidates.rows.length, 0)
    const conflicting = await request('POST', '/api/roster/correspondences/preflight', decision('unknown-conflict', [create({ type: 'event_process', eventId: f.events.G[0], relationId: f.relations[11][1], role: 'context_only' })]), { auth: true, allow: [422] })
    assert.equal(conflicting.value.error.code, 'identity_conflict')
    const uncertain = await request('POST', '/api/roster/correspondences/preflight', decision('unknown-null', [create({ type: 'event_process', eventId: f.events.G[0], relationId: f.relations[11][0], role: 'context_only' })]), { auth: true, allow: [422] })
    assert.ok(['identity_unverified', 'incomplete_coverage', 'ambiguous_candidate'].includes(uncertain.value.error.code), `unexpected unknown identity code ${uncertain.value.error.code}`)
  })
  await checked('scenario 8 setup: direct event, relation, and export reverse public references', async () => {
    const choice = await decide('export-context', [
      create({ type: 'event_export_context', eventId: f.events.E[0], exportRowId: f.exportRows[1], role: 'current_snapshot_context' }),
      create({ type: 'event_recognized', eventId: f.events.E[0], relationId: f.relations[7][0], role: 'current_context' }, 'candidate'),
    ])
    f.edgeIds.exportE = choice.committed.correspondenceIds[0]
    const edge = await get(`/api/roster/correspondences/${choice.committed.correspondenceIds[0]}`)
    assert.equal(edge.exportRow.id, f.exportRows[1])
    assert.equal(edge.event.officialEvidence[0].storedFile.sha256, f.file.sha256)
    const reverse = await get(`/api/roster/correspondences/export-rows/${f.exportRows[1]}`)
    assert.ok(reverse.correspondences.some(item => item.eventId === f.events.E[0]))
    const relation = await get(`/api/roster/correspondences/relations/${f.relations[7][0]}`)
    assert.ok(relation.correspondences.some(item => item.eventId === f.events.E[0] && item.status === 'candidate'))
    const none = await get(`/api/roster/correspondences/events/${f.events.H[0]}`)
    assert.equal(none.correspondences.length, 0)
  })
  await checked('scenario 9: stale plan rejects whole batch, replay is stable, audit is append-only', async () => {
    const first = await decide('audit-candidate', [create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][0], role: 'context_only' }, 'candidate')])
    const id = first.committed.correspondenceIds[0]
    const stale = decision('stale-plan', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' },
      create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][6], role: 'context_only' }, 'candidate')])
    const stalePlan = await post('/api/roster/correspondences/preflight', stale)
    await decide('revision-winner', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'rejected' }])
    const rejected = await request('POST', '/api/roster/correspondences/commit', { request: stale, planHash: stalePlan.planHash }, { auth: true, allow: [409] })
    assert.ok(['stale_revision', 'plan_mismatch'].includes(rejected.value.error.code))
    const before = await get('/api/roster/correspondences')
    assert.equal(before.rows.filter(item => item.relationId === f.relations[12][6]).length, 0)
    const replay = await post('/api/roster/correspondences/commit', { request: first.input, planHash: first.planned.planHash })
    assert.deepEqual(replay, first.committed)
    const changed = await request('POST', '/api/roster/correspondences/preflight', { ...first.input, basis: 'different evidence' }, { auth: true, allow: [409] })
    assert.equal(changed.value.error.code, 'idempotency_conflict')
    const audit = await get(`/api/roster/correspondences/${id}/audit`)
    assert.deepEqual(audit.rows.map(item => item.toStatus), ['candidate', 'rejected'])
    const receipt = await get(`/api/roster/correspondences/batches/${encodeURIComponent(first.input.idempotencyKey)}`, { auth: true })
    assert.deepEqual(receipt, first.committed)
  })
  await checked('real MCP discovery, authenticated write, and read parity', async () => {
    const anonymous = await mcpRpc('tools/list', {})
    assert.ok(anonymous.tools.some(item => item.name === 'list_record_correspondences'))
    assert.ok(!anonymous.tools.some(item => item.name === 'save_record_correspondences'))
    const authenticated = await mcpRpc('tools/list', {}, true)
    assert.ok(authenticated.tools.some(item => item.name === 'preflight_record_correspondences'))
    assert.ok(authenticated.tools.some(item => item.name === 'save_record_correspondences'))
    const written = await decide('mcp-parity', [create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][1], role: 'context_only' }, 'candidate')], 'mcp')
    f.edgeIds.mcpCandidate = written.committed.correspondenceIds[0]
    const rest = await get(`/api/roster/correspondences/${written.committed.correspondenceIds[0]}`)
    const mcp = await mcpCall('get_record_correspondence', { id: rest.id })
    assert.deepEqual(mcp, rest)
  })
  await checked('scenario 9 mixed decision: confirm, reject, unlink, and correct share one impact and audit', async () => {
    const rejectedCandidate = await decide('mixed-reject-seed', [create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][2], role: 'context_only' }, 'candidate')])
    const toReject = rejectedCandidate.committed.correspondenceIds[0]
    const unlinkSeed = await decide('mixed-unlink-seed', [create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][3], role: 'context_only' })])
    const toUnlink = unlinkSeed.committed.correspondenceIds[0]
    const correctSeed = await decide('mixed-correct-seed', [create({ type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][4], role: 'context_only' })])
    const toCorrect = correctSeed.committed.correspondenceIds[0]
    const mixed = await decide('mixed-four-transitions', [
      { action: 'decide', correspondenceId: f.edgeIds.mcpCandidate, expectedRevision: 1, status: 'confirmed' },
      { action: 'decide', correspondenceId: toReject, expectedRevision: 1, status: 'rejected' },
      { action: 'decide', correspondenceId: toUnlink, expectedRevision: 2, status: 'unlinked' },
      { action: 'correct', correspondenceId: toCorrect, expectedRevision: 2,
        edge: { type: 'event_process', eventId: f.events.H[0], relationId: f.relations[12][5], role: 'context_only' } },
    ])
    assert.equal(mixed.committed.impact.audit, mixed.planned.impact.audit)
    const list = await get('/api/roster/correspondences')
    assert.equal(list.rows.find(row => row.id === f.edgeIds.mcpCandidate).status, 'confirmed')
    assert.equal(list.rows.find(row => row.id === toReject).status, 'rejected')
    assert.equal(list.rows.find(row => row.id === toUnlink).status, 'unlinked')
    assert.equal(list.rows.find(row => row.id === toCorrect).status, 'unlinked')
    assert.ok(list.rows.some(row => row.eventId === f.events.H[0] && row.relationId === f.relations[12][5] && row.status === 'confirmed'))
    for (const id of [f.edgeIds.mcpCandidate, toReject, toUnlink, toCorrect]) {
      const audit = await get(`/api/roster/correspondences/${id}/audit`)
      assert.ok(audit.rows.some(row => row.idempotencyKey === mixed.input.idempotencyKey))
    }
  })
  await checked('legacy impact remains read-only and source scoped', async () => {
    const legacy = await get(compareQuery().replace('/record-comparison?', '/record-comparison/legacy-impact?'))
    assert.ok(Array.isArray(legacy.rows))
    assert.ok(Array.isArray(legacy.dataIssues))
    assert.ok(Array.isArray(legacy.modelIssues))
  })
}

async function verifyProof() {
  // All proof writes and reads cross the real #72 REST/MCP transport.
  const discover = await request('GET', '/api/roster/comparison-scope-proofs', undefined, { allow: [200, 404] })
  if ((discover.status === 404 || !discover.value || typeof discover.value !== 'object' || !Array.isArray(discover.value.rows)) && mode !== 'acceptance') {
    report.pending.push(`#72 public comparison-scope-proofs API unavailable (GET returned ${discover.status} ${typeof discover.value === 'string' ? 'HTML fallback' : 'non-list body'}); qualified scenarios 5/6/9 remain unrun`)
    return
  }
  assert.equal(discover.status, 200, 'final acceptance requires public scope proof routes')
  assert.ok(Array.isArray(discover.value.rows), 'final acceptance requires a proof list JSON response, not Nuxt HTML fallback')
  const f = fixture
  const evidence = (enterpriseId, year = 2024) => {
    const listNo = enterpriseId === f.enterprises.E ? 8 : enterpriseId === f.enterprises.F ? 9 : enterpriseId === f.enterprises.H ? 11 : 10
    return { titleCode: T.specialized, fromYear: year, throughYear: year,
    enterpriseIds: [enterpriseId], fullRange: true, sourceDocuments: [{ id: f.officialDocumentId, fileId: f.file.id,
      sha256: f.file.sha256, reference: { field: 'record_evidence.source_file', page: listNo % 3 + 1, listNo } }] }
  }
  const proofRequest = (label, operations) => ({ idempotencyKey: `spec63-${nonce}-proof-${label}`,
    sourceIdentity: f.sourceFile, actor: { type: 'agent', id: 'synthetic-acceptance' },
    basis: `Explicit synthetic source and scope attestation for ${label}`,
    ruleId: 'manual-synthetic-scope', ruleVersion: '1', operations })
  async function proofWrite(label, operations, transport = 'rest') {
    const input = proofRequest(label, operations)
    const preflight = transport === 'mcp' ? await mcpCall('preflight_comparison_scope_proofs', input, true)
      : await post('/api/roster/comparison-scope-proofs/preflight', input)
    assert.match(preflight.planHash, /^[0-9a-f]{64}$/)
    const committed = transport === 'mcp' ? await mcpCall('commit_comparison_scope_proofs', { request: input, planHash: preflight.planHash }, true)
      : await post('/api/roster/comparison-scope-proofs/commit', { request: input, planHash: preflight.planHash })
    assert.deepEqual(committed.impact, preflight.impact)
    return { input, preflight, committed }
  }
  const ids = {}
  await checked('public scope proof: confirmed official coverage qualifies only selected scoped source', async () => {
    const written = await proofWrite('official-confirmed', [{ action: 'create', kind: 'official_coverage',
      status: 'confirmed', evidence: evidence(f.enterprises.E) }])
    ids.confirmedOfficial = written.committed.proofIds[0]
    const proof = await get(`/api/roster/comparison-scope-proofs/${ids.confirmedOfficial}`)
    assert.equal(proof.status, 'confirmed')
    assert.equal(proof.valid, true)
    assert.equal(proof.sourceSummary.documents[0].sha256, f.file.sha256)
    const unselected = await get(compareQuery())
    assert.equal(unselected.officialCoverage.qualification, 'unknown')
    const selected = await get(compareQuery([ids.confirmedOfficial]))
    assert.equal(selected.officialCoverage.qualification, 'verified')
    assert.deepEqual(selected.officialCoverage.proofIds, [String(ids.confirmedOfficial)])
    const audit = await get(`/api/roster/comparison-scope-proofs/${ids.confirmedOfficial}/audit`)
    assert.deepEqual(audit.rows.map(row => row.toStatus), ['candidate', 'confirmed'])
    try {
      const mcpAudit = await mcpCall('get_comparison_scope_proof_audit', { id: ids.confirmedOfficial, page: 1, pageSize: 50 })
      assert.deepEqual(mcpAudit, audit)
      report.checks.push('real MCP proof audit equals REST audit')
    } catch (error) {
      if (mode === 'acceptance') throw error
      report.pending.push(`Real MCP proof audit blocked: ${String(error.message).slice(0, 500)}`)
    }
    const replay = await post('/api/roster/comparison-scope-proofs/commit', { request: written.input, planHash: written.preflight.planHash })
    assert.deepEqual(replay, written.committed)
  })
  await checked('public scope proof: candidate and revoked are visible but never qualify', async () => {
    const candidate = await proofWrite('official-candidate', [{ action: 'create', kind: 'official_coverage',
      status: 'candidate', evidence: evidence(f.enterprises.F) }], 'mcp')
    ids.candidateOfficial = candidate.committed.proofIds[0]
    const revoked = await proofWrite('official-revoked-seed', [{ action: 'create', kind: 'official_coverage',
      status: 'confirmed', evidence: evidence(f.enterprises.F) }])
    ids.revokedOfficial = revoked.committed.proofIds[0]
    await proofWrite('official-revoke', [{ action: 'decide', proofId: ids.revokedOfficial, expectedRevision: 2, status: 'revoked' }])
    const listed = await get('/api/roster/comparison-scope-proofs')
    assert.equal(listed.rows.find(row => row.id === ids.candidateOfficial).status, 'candidate')
    assert.equal(listed.rows.find(row => row.id === ids.revokedOfficial).status, 'revoked')
    const selected = await get(compareQuery([ids.candidateOfficial, ids.revokedOfficial]))
    assert.equal(selected.officialCoverage.qualification, 'unknown')
    const mcp = await mcpCall('get_comparison_scope_proof', { id: ids.candidateOfficial })
    assert.deepEqual(mcp, listed.rows.find(row => row.id === ids.candidateOfficial))
  })
  await checked('public scope proof: changed scoped official rows invalidate a confirmed proof without deleting audit', async () => {
    const written = await proofWrite('official-stale-seed', [{ action: 'create', kind: 'official_coverage',
      status: 'confirmed', evidence: evidence(f.enterprises.H) }])
    ids.staleOfficial = written.committed.proofIds[0]
    assert.equal((await get(`/api/roster/comparison-scope-proofs/${ids.staleOfficial}`)).valid, true)
    await importBatch('official-stale-new-event', 'announcement', f.sourceFile, { announcement: {
      sourceDocument: { source: 'jxj', title: '六三号合成验收三页公告', docNumber: `S63-${nonce}`, issueDate: '2024-10-18' },
      records: [{ enterprise: person.H, titleCode: T.specialized, events: [{ eventType: 'award', year: 2024,
        batchSeq: 2, evidence: [{ sourceFile: f.sourceFile, attachment: '合成附件一', listNo: 12, page: 1 }] }] }],
    } }, f.file.sha256)
    const proof = await get(`/api/roster/comparison-scope-proofs/${ids.staleOfficial}`)
    assert.equal(proof.status, 'confirmed')
    assert.equal(proof.valid, false)
    assert.equal(proof.invalidReason, 'source_drift_or_missing')
    const selected = await get(compareQuery([ids.staleOfficial]))
    assert.equal(selected.officialCoverage.qualification, 'unknown')
    const audit = await get(`/api/roster/comparison-scope-proofs/${ids.staleOfficial}/audit`)
    assert.deepEqual(audit.rows.map(row => row.toStatus), ['candidate', 'confirmed'])
  })
  await checked('public scope proof: archived freeze file/hash is real; narrowed query cannot attest current equivalence', async () => {
    const freeze = f.exportFiles[1]
    const response = await fetch(`${base}/api/files/${freeze.path}`)
    assert.equal(response.status, 200)
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), freeze.sha256)
    const conditions = { uscc: person.E.uscc, combination: 'and' }
    const current = proofRequest('current-narrowed', [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: {
      queryId: f.queryIds[7], exportBatchId: f.exportBatches[1], titleCode: T.specialized,
      queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256',
      scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account',
        queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: conditions,
        exportFilters: conditions, windowStart: '2026-10-18T00:00:00.000Z',
        windowEnd: '2026-10-18T23:59:59.000Z', platformVersion: `synthetic-v2-${nonce}`,
        freezeReference: freeze.path, freezeFileId: freeze.id, freezeSha256: freeze.sha256 },
    } }])
    const rejected = await request('POST', '/api/roster/comparison-scope-proofs/preflight', current, { auth: true, allow: [422] })
    assert.equal(rejected.value.error.code, 'insufficient_evidence')
    const recognized = await get(compareQuery([ids.confirmedOfficial]))
    assert.equal(recognized.currentSourceConsistency.qualification, 'not_comparable')
    report.pending.push(`Current-source proof preflight rejects archived subject-narrowed query ${f.queryIds[7]}: HTTP ${rejected.status} ${rejected.value.error.code}: ${rejected.value.error.message}`)
  })
  if (f.broadArchive.conflicts.length) {
    const first = f.broadArchive.conflicts[0]
    report.pending.push(`Public import preflight rejects synthetic unnarrowed recognized archive: ${first.error.code}: ${first.error.message}`)
  }
  if (!f.broadArchive.queryId) {
    if (mode === 'acceptance') assert.fail('final qualified current-source assertions require a public archived unnarrowed recognized query')
    report.pending.push('Qualified current-source matched/field_conflict and confirmed recognized_export remain unrun; public broad recognized archive is required')
    return ids
  }
  const selectedComparison = (batchId, proofIds = []) => comparisonPath([f.broadArchive.queryId], [batchId], proofIds)
    .replace('/comparison?mode=record', '/api/roster/record-comparison?')
  const currentEvidence = (index) => {
    const freeze = f.exportFiles[index]
    const filters = { combination: 'and' }
    return { queryId: f.broadArchive.queryId, exportBatchId: f.exportBatches[index], titleCode: T.specialized,
      queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256',
      scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account',
        queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: filters,
        exportFilters: filters, windowStart: '2026-10-18T00:00:00.000Z',
        windowEnd: '2026-10-18T23:59:59.000Z', platformVersion: `synthetic-freeze-${nonce}-${index}`,
        freezeReference: freeze.path, freezeFileId: freeze.id, freezeSha256: freeze.sha256 } }
  }
  await checked('scenario 5 qualified: persisted current proof changes unknown to matched and field conflict by version', async () => {
    const baseline = await get(selectedComparison(f.exportBatches[1]))
    assert.equal(baseline.currentSourceConsistency.recognizedObservations[0].qualification, 'not_comparable')
    const matched = await proofWrite('current-matched-v2', [{ action: 'create', kind: 'current_source_equivalence',
      status: 'confirmed', evidence: currentEvidence(1) }])
    ids.currentMatched = matched.committed.proofIds[0]
    const qualified = await get(selectedComparison(f.exportBatches[1], [ids.currentMatched]))
    assert.equal(qualified.currentSourceConsistency.recognizedObservations[0].qualification, 'matched')
    assert.equal(qualified.currentSourceConsistency.recognizedObservations[0].proofId, String(ids.currentMatched))
    const conflict = await proofWrite('current-conflict-v1', [{ action: 'create', kind: 'current_source_equivalence',
      status: 'confirmed', evidence: currentEvidence(0) }])
    ids.currentConflict = conflict.committed.proofIds[0]
    const conflicting = await get(selectedComparison(f.exportBatches[0], [ids.currentConflict]))
    assert.equal(conflicting.currentSourceConsistency.recognizedObservations[0].qualification, 'field_conflict')
    assert.equal(conflicting.currentSourceConsistency.recognizedObservations[0].recognized.id, f.broadArchive.relationId)
    assert.equal(conflicting.currentSourceConsistency.recognizedObservations[0].exportRows[0].id, f.exportRows[0])
  })
  await checked('scenario 5 qualified: recognized/export confirmation binds persisted proof and preserves omitted-proof decision', async () => {
    const first = await decide('broad-recognized-export-candidate', [create({ type: 'recognized_export',
      relationId: f.broadArchive.relationId, exportRowId: f.exportRows[1], role: 'same_current_row' }, 'candidate')])
    const firstId = first.committed.correspondenceIds[0]
    await decide('broad-recognized-export-confirm', [{ action: 'decide', correspondenceId: firstId,
      expectedRevision: 1, status: 'confirmed' }], 'rest', [ids.currentMatched])
    assert.equal((await get(`/api/roster/correspondences/${firstId}`)).status, 'confirmed')
    const second = await decide('broad-recognized-export-stored-proof', [create({ type: 'recognized_export',
      relationId: f.broadArchive.relationId, exportRowId: f.exportRows[0], role: 'same_current_row' }, 'candidate')], 'rest', [ids.currentConflict])
    const secondId = second.committed.correspondenceIds[0]
    await decide('broad-recognized-export-confirm-omitted-proof', [{ action: 'decide', correspondenceId: secondId,
      expectedRevision: 1, status: 'confirmed' }])
    assert.equal((await get(`/api/roster/correspondences/${secondId}`)).status, 'confirmed')
  })
  return ids
}

async function verifyFinalDisplay() {
  const f = fixture
  const result = await get(compareQuery())
  const row = (eventId) => {
    const found = result.rows.find(item => item.event.id === eventId)
    assert.ok(found, `final comparison missing event ${eventId}`)
    return found
  }
  await checked('final scenario 1: A remains aligned with confirmed award and returned 2025 update', async () => {
    const award = row(f.events.A[0])
    assert.equal(award.classification, 'historical_aligned')
    assert.equal(award.event.year, 2021)
    assert.ok(award.platformRows.some(item => item.id === f.relations[0][0] && item.status === '已通过'))
    assert.ok(award.laterProcesses.some(item => item.relation.id === f.relations[1][0] && item.relation.year === 2025 && item.relation.status === '退回'))
    assert.equal((await get(`/api/roster/correspondences/${f.edgeIds.awardA}`)).status, 'confirmed')
  })
  await checked('final scenario 2: B remains same-batch pending conflict', async () => {
    const award = row(f.events.B[0])
    assert.equal(award.classification, 'historical_conflict')
    assert.ok(award.platformRows.some(item => item.id === f.relations[2][0] && item.status === '待审核'))
  })
  await checked('final scenario 3: C review keeps 2021 original, 2024 decision, and separate 2025 application', async () => {
    const review = row(f.events.C[1])
    assert.equal(review.event.year, 2021)
    assert.equal(review.event.decidedYear, 2024)
    assert.equal(review.classification, 'historical_aligned')
    assert.ok(review.platformRows.some(item => item.id === f.relations[3][0] && item.status === '终审不通过'))
    assert.ok(review.laterProcesses.some(item => item.relation.id === f.relations[4][0] && item.relation.year === 2025 && item.relation.status === '待审核'))
  })
  await checked('final scenario 4: D retains both titles and all eight original rows', async () => {
    assert.equal(row(f.events.D2022[0]).event.year, 2022)
    assert.equal(row(f.events.Dinnovative[0]).event.year, 2023)
    const source = await get(`/api/platform/queries?queryKey=${queryKey(person.D.uscc)}&pageSize=50`)
    assert.equal(source.rows.find(item => item.query.id === f.queryIds[5]).relations.length, 6)
    assert.equal(source.rows.find(item => item.query.id === f.queryIds[6]).relations.length, 2)
  })
  await checked('final scenario 5: E retains recognized row and both export versions without current proof qualification', async () => {
    assert.equal(row(f.events.E[0]).event.year, 2024)
    assert.equal(result.currentSourceConsistency.qualification, 'not_comparable')
    assert.ok(result.currentSourceConsistency.recognizedObservations.some(item => item.recognized.id === f.relations[7][0]
      && f.exportRows.every(id => item.exportRows.some(exportRow => exportRow.id === id))))
  })
  await checked('final scenario 6: F partial, complete zero, and failure remain distinct', async () => {
    const statuses = new Map(result.coverage.map(item => [item.queryId, item.status]))
    assert.equal(statuses.get(f.queryIds[8]), 'partial')
    assert.equal(statuses.get(f.queryIds[9]), 'no_record')
    assert.equal(statuses.get(f.queryIds[10]), 'failed')
    assert.equal(row(f.events.F[0]).classification, 'official_without_correspondence')
  })
  await checked('final scenario 7: G nullable identity and conflicting raw identity stay pending', async () => {
    const uncertain = result.platformWithoutOfficial.rows.find(item => item.relation.id === f.relations[11][0])
    const conflicting = result.platformWithoutOfficial.rows.find(item => item.relation.id === f.relations[11][1])
    assert.equal(uncertain?.relation.enterpriseId, null)
    assert.equal(uncertain?.relation.verificationStatus, 'pending')
    assert.equal(conflicting?.relation.verificationStatus, 'pending')
    assert.equal(row(f.events.G[0]).classification, 'unresolved')
  })
}

async function main() {
  try {
    service = await startIsolatedNuxt({ cwd: resolve(import.meta.dirname, '..'),
      portHint: Number(process.env.SPEC63_PORT ?? 0), env: {
        NUXT_DB_PATH: join(root, 'roster.db'), NUXT_FILES_DIR: files,
        NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_API_TOKEN: apiToken,
        NUXT_MCP_TOKEN: mcpToken, NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', NUXT_IGNORE_LOCK: '1',
      } })
    base = service.baseUrl
    fixture = await seed()
    const manifest = { synthetic: true, sourceHead: report.sourceHead, root, baseUrl: base,
      ownerPid: process.pid, serverPid: service.child.pid, sourceFile: fixture.sourceFile,
      storedFile: fixture.file, officialSourceDocumentId: fixture.officialDocumentId,
      enterprises: fixture.enterprises, events: fixture.events,
      queryIds: fixture.queryIds, relations: fixture.relations,
      exportBatchIds: fixture.exportBatches, exportRowIds: fixture.exportRows, exportFiles: fixture.exportFiles,
      broadArchive: fixture.broadArchive,
      comparisonUrl: base + comparisonPath(), legacyUrl: base + '/comparison?mode=legacy',
      pdfUrl: `${base}/api/files/${fixture.sourceFile}`,
      enterpriseUrls: Object.fromEntries(Object.entries(fixture.enterprises).map(([key, id]) => [key, `${base}/enterprises/${id}`])),
      apiComparisonUrl: base + compareQuery() }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    chmodSync(manifestPath, 0o600)
    writeFileSync(privatePath, JSON.stringify({ pid: process.pid, childPid: service.child.pid, baseUrl: base,
      dbPath: join(root, 'roster.db'), filesDir: files, incomingDir: join(root, 'incoming'),
      apiToken, mcpToken }, null, 2), { mode: 0o600 })
    console.log(`Synthetic fixture manifest: ${manifestPath}`)
    if (mode !== 'fixture-only') {
      await verifyAvailable()
      const proofs = await verifyProof()
      await verifyFinalDisplay()
      if (proofs) {
        manifest.proofIds = proofs
        manifest.comparisonWithOfficialProofUrl = base + comparisonPath(fixture.queryIds, fixture.exportBatches, [proofs.confirmedOfficial])
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      }
    }
    report.lanes.api = { status: report.pending.length ? 'blocked' : 'passed', checks: report.checks.length,
      blockers: [...report.pending] }
    if (mode === 'acceptance') assert.equal(report.pending.length, 0, 'final API acceptance has unresolved blockers')
    console.log(JSON.stringify(report, null, 2))
    if (mode === 'serve') {
      console.log(`Owned synthetic Nuxt serving ${base}; press Ctrl-C to stop`)
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
  } finally {
    await service?.stop()
    if (mode === 'acceptance' || mode === 'setup') {
      rmSync(root, { recursive: true, force: true })
      try { unlinkSync(manifestPath) } catch { /* already removed */ }
    } else {
      try { unlinkSync(privatePath) } catch { /* already removed */ }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
