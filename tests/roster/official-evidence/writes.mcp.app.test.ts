import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OfficialPublishedRow, RosterImportPayload } from '../../../layers/sme-roster/lib/roster-import-client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresFixtureRows } from './fixtures/postgres-rows'

const bytes = 'synthetic MCP source'
const sha256 = createHash('sha256').update(bytes).digest('hex')
const token = 'synthetic-official-evidence-mcp'
const root = mkdtempSync(join(tmpdir(), 'official-evidence-mcp-'))
let dir: string
let filesDir: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let pool: pg.Pool | undefined
let child: ReturnType<typeof spawnCompiledApp> | undefined
let client: Client | undefined
let readFirst: ReturnType<typeof postgresFixtureRows>['readFirst']
let serial = 0
let caseSerial = 0

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir: root })
}, 90000)
beforeEach(async () => {
  dir = mkdtempSync(join(root, 'case-'))
  filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  writeFileSync(join(filesDir, 'notice.txt'), bytes)
  const database = 'official_evidence_case_' + ++caseSerial
  postgres!.psql(['-d', 'template1', '-c', 'CREATE DATABASE ' + database + ' TEMPLATE postgres'])
  const connection = new URL(postgres!.url)
  connection.pathname = '/' + database
  pool = new pg.Pool({ connectionString: connection.href, options: '-c search_path=business,public' })
  readFirst = postgresFixtureRows(pool).readFirst
  await pool.query(`
    INSERT INTO enterprise(id,name,name_norm) VALUES(1,'Alpha','Alpha'),(2,'Beta','Beta');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,1,'review',2024),(3,2,'award',2021);
    INSERT INTO source_document(source,title,path) VALUES('jxj','Explicit publication','notice.txt');
  `)
  await pool.query(`
    INSERT INTO stored_file(rel_path,filename,ext,bytes,sha256,created_at)
    VALUES('notice.txt','notice.txt','txt',$1,$2,'synthetic')
  `, [Buffer.byteLength(bytes), sha256])
  await pool.query(`
    INSERT INTO roster_file_classification(file_id, source, kind, title_code)
    VALUES (1, 'jxj', 'announcement', 'specialized_sme')
  `)
  const port = await reserveLoopbackPort()
  child = spawnCompiledApp(port, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...postgres!.env,
      NUXT_POSTGRES_DIRECTORY_URL: connection.href, NUXT_POSTGRES_LOG_URL: connection.href,
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token, NUXT_DB_READONLY: '0',
      NUXT_FILES_DIR: filesDir, NUXT_INCOMING_DIR: join(dir, 'incoming'),
    },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  const base = 'http://127.0.0.1:' + port
  try { await waitForHttp(base + '/api/health', { timeoutMs: 60000, child }) }
  catch (cause) { throw new Error('Official evidence test app did not start\n' + output, { cause }) }
  client = new Client({ name: 'official-evidence-fixture', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { authorization: 'Bearer ' + token } },
  }))
}, 90000)
afterEach(async () => {
  try { await client?.close() }
  finally {
    try { if (child) await stopOwnedChild(child) }
    finally {
      try { await pool?.end() }
      finally {
        if (caseSerial) postgres?.psql(['-d', 'template1', '-c', 'DROP DATABASE IF EXISTS official_evidence_case_' + caseSerial])
        if (dir) rmSync(dir, { recursive: true, force: true })
        client = undefined
        child = undefined
        pool = undefined
      }
    }
  }
})
afterAll(() => {
  try { postgres?.close() }
  finally { rmSync(root, { recursive: true, force: true }) }
})

function row(over: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow {
  return { nameRaw: 'Published Alpha', usccRaw: null, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'Verified original declaration' }, storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(bytes), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified original row', ...over }
}
async function append(eventId: number, publishedRow = row()) {
  const event = await readFirst('SELECT revision FROM record_event WHERE id=$1', [eventId])
  return {
    eventId, recordId: eventId === 3 ? 2 : 1, enterpriseId: eventId === 3 ? 2 : 1,
    expectedVersion: Number(event!.revision),
    evidence: { sourceFile: 'notice.txt', attachment: null, listNo: publishedRow.listNo, page: null, publishedRow },
  }
}
function request(payload: RosterImportPayload) { return { idempotencyKey: 'mcp-' + serial++, sourceKind: 'announcement', sourceIdentity: 'synthetic', payload } }
async function call(name: string, args: object): Promise<any> {
  const result = await client!.callTool({ name, arguments: args as Record<string, unknown> })
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text)
}
async function commit(payload: RosterImportPayload) {
  const input = request(payload), plan = await call('preflight_roster_batch', input)
  expect(plan, JSON.stringify(plan)).toHaveProperty('preflight.conflicts')
  expect(plan.preflight.conflicts).toEqual([])
  const bound = { ...input, payload: { ...payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } }
  const saved = await call('save_roster_batch', bound)
  expect(saved.status, JSON.stringify(saved)).toBe('committed')
  expect(await call('save_roster_batch', bound)).toEqual(saved)
  return saved
}
it('discovers exact additive schemas through real MCP tools list', async () => {
  const tools = (await client!.listTools()).tools
  const save = tools.find(tool => tool.name === 'save_roster_batch')!
  expect(JSON.stringify(save.inputSchema)).toContain('officialEvidenceAppends')
  expect(JSON.stringify(save.inputSchema)).toContain('publishedRow')
  expect(JSON.stringify(save.inputSchema)).toContain('expectedRowRevision')
  expect(JSON.stringify(save.inputSchema)).toContain('officialEvidencePlanHash')
})
it('commits compatible source associations and genuine same-key receipts through the real import process', async () => {
  const first = await commit({ officialEvidenceAppends: [await append(1)] })
  const evidenceId = first.items.find((item: any) => item.kind === 'official_evidence').detail.evidence[0].evidenceId
  expect((await call('get_roster_evidence', { id: evidenceId, official: 'latest' })).official.row).toMatchObject({ nameRaw: 'Published Alpha', eventId: 1 })
  await commit({ officialEvidenceAppends: [await append(2, row({ nameRaw: null }))] })
  expect(await readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 2 })
}, 10000)
async function seedPair() { await commit({ officialEvidenceAppends: [await append(1)] }); await commit({ officialEvidenceAppends: [await append(2, row({ nameRaw: null }))] }) }
it('rejects a cross-owner claim atomically through actual MCP preflight and app commit', async () => {
  await seedPair()
  const input = request({ officialEvidenceAppends: [await append(3)] })
  const plan = await call('preflight_roster_batch', input)
  expect(plan.preflight.conflicts[0].error.code).toBe('source_row_conflict')
  const saved = await call('save_roster_batch', input)
  expect(saved.status).toBe('failed')
  expect(await readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 2 })
})
it('combines append and raw-only correction using one original event version and one CAS through MCP', async () => {
  await seedPair()
  const evidenceId = Number((await readFirst('SELECT id FROM record_evidence WHERE record_event_id=1'))!.id)
  const before = await call('get_roster_evidence', { id: evidenceId })
  const originalVersion = Number((await readFirst('SELECT revision FROM record_event WHERE id=1'))!.revision)
  const publishedRow = row({ nameRaw: 'Explicit corrected raw' })
  const saved = await commit({ officialEvidenceAppends: [await append(1, row({ listNo: 20 }))], officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Explicit correction', operations: [{ evidenceId, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: before.version, expectedRowRevision: 1, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }, publishedRow }] } })
  expect((await call('get_roster_evidence', { id: evidenceId, official: 'latest' })).official.row).toMatchObject({ revision: 2, nameRaw: 'Explicit corrected raw' })
  expect(await readFirst('SELECT revision FROM record_event WHERE id=1')).toEqual({ revision: originalVersion + 1 })
  const audit = (await readFirst('SELECT batch_key AS "batchKey", "after"::json FROM evidence_correction_audit'))!
  expect(audit.batchKey).toBeNull(); expect(z.object({ importBatchId: z.number().int().positive() }).passthrough().parse(audit.after).importBatchId).toBe(saved.batchId)
})
it('rechecks the actual configured file bytes inside the import process after MCP preflight', async () => {
  await seedPair()
  const input = request({ officialEvidenceAppends: [await append(1, row({ listNo: 30 }))] })
  const plan = await call('preflight_roster_batch', input); expect(plan.preflight.conflicts).toEqual([])
  writeFileSync(join(filesDir, 'notice.txt'), 'changed after preflight')
  const saved = await call('save_roster_batch', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } })
  expect(saved.status).toBe('failed'); expect(saved.items.some((item: any) => item.error?.code === 'file_changed')).toBe(true)
  expect(await readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 2 })
})
it('rolls back a new independent declaration and append after a real PostgreSQL write failure', async () => {
  await seedPair()
  const independent = row({ declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'New separate publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Verified independent official publication' } })
  const input = request({ officialEvidenceAppends: [await append(1, independent)] })
  const plan = await call('preflight_roster_batch', input); expect(plan.preflight.conflicts).toEqual([])
  await pool!.query(`
    CREATE FUNCTION business.synthetic_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic failure';
    END
    $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON official_evidence_row_revision
    FOR EACH ROW WHEN (NEW.source_document_id <> 1) EXECUTE FUNCTION business.synthetic_failure()
  `)
  const result = await call('save_roster_batch', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } })
  expect(result).toMatchObject({ status: 'failed', items: [{ error: { code: 'commit_rolled_back' } }] })
  expect(await readFirst(`
    SELECT b.status AS batch_status, r.status AS receipt_status
    FROM import_batch b JOIN import_receipt r ON r.batch_id = b.id
    WHERE b.idempotency_key = $1 AND r.operation = 'commit'
  `, [input.idempotencyKey])).toEqual({ batch_status: 'failed', receipt_status: 'failed' })
  expect(await readFirst('SELECT count(*) n FROM source_document')).toEqual({ n: 1 })
  expect(await readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 2 })
  expect(await readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 2 })
  expect(await readFirst('SELECT revision FROM record_event WHERE id=1')).toEqual({ revision: 2 })
})
it('serializes competing MCP submissions and rejects the incompatible final source claim', async () => {
  const a = request({ officialEvidenceAppends: [await append(1, row({ listNo: 30 }))] })
  const b = request({ officialEvidenceAppends: [await append(3, row({ listNo: 30 }))] })
  const pa = await call('preflight_roster_batch', a), pb = await call('preflight_roster_batch', b)
  expect(pa.preflight.conflicts).toEqual([]); expect(pb.preflight.conflicts).toEqual([])
  const results = await Promise.all([
    call('save_roster_batch', { ...a, payload: { ...a.payload, officialEvidencePlanHash: pa.preflight.officialEvidencePlanHash } }),
    call('save_roster_batch', { ...b, payload: { ...b.payload, officialEvidencePlanHash: pb.preflight.officialEvidencePlanHash } }),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['committed', 'failed'])
  expect(results.find(result => result.status === 'failed').items.some((item: any) => item.error?.code === 'source_row_conflict')).toBe(true)
  expect(await readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 1 })
})
