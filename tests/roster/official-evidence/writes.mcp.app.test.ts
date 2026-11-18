import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportPayload } from '../../../lib/roster-import-client'
import { createEnterpriseReadProcess } from '../../../server/utils/enterprise-read-process'
import { importExecutor } from '../../../server/utils/import-execution'
import { readExactEvidence } from '../../../server/utils/roster-evidence-correction'
import { readLatestOfficialEvidence } from '../../../server/utils/official-evidence'
import { readMcpToken, resolveMcpAuth } from '../../../layers/core/server/utils/mcp-auth'

// Dedicated transport suite: run only in the parent's heavy slot. Production tools,
// SDK HTTP transport and the real serial import process execute against one synthetic DB.
const current = vi.hoisted(() => ({ db: null as unknown }))
// Match the deployed worker entry; avoid compiling the source graph on first admission.
vi.mock('../../../server/utils/import-execution-worker-location', () => ({
  createImportExecutionWorker: () => createEnterpriseReadProcess(new URL('../../../.output/server/import-execution-worker.mjs', import.meta.url)),
}))
vi.mock('@db', () => ({ useDb: () => current.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const bytes = 'synthetic MCP source', sha256 = createHash('sha256').update(bytes).digest('hex')
function makeFixture() {
const dir = mkdtempSync('/tmp/issue350-mcp-'), filesDir = join(dir, 'files')
mkdirSync(filesDir)
writeFileSync(join(filesDir, 'notice.txt'), bytes)
const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
const db = drizzle(sqlite, { schema }); createRuntimeSchema(sqlite)
sqlite.exec(`INSERT INTO enterprise(id,name,name_norm) VALUES(1,'Alpha','Alpha'),(2,'Beta','Beta');
  INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
  INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,1,'review',2024),(3,2,'award',2021);
  INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Explicit publication','notice.txt');
  INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt',${Buffer.byteLength(bytes)},'${sha256}','synthetic');
  INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (1, 'jxj', 'announcement', 'specialized_sme');`)
  return { db, sqlite, filesDir }
}
let db: ReturnType<typeof makeFixture>['db'], sqlite: Database.Database, filesDir: string
const handles: Database.Database[] = []
beforeEach(() => { const fixture = makeFixture(); db = fixture.db; sqlite = fixture.sqlite; filesDir = fixture.filesDir; current.db = db; handles.push(sqlite) })
const token = 'synthetic-issue350-mcp'
let server: ReturnType<typeof createServer>, client: Client
const transports = new Set<StreamableHTTPServerTransport>()
let serial = 0
beforeAll(async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir, apiToken: token, mcpToken: token }))
  vi.stubGlobal('createError', (input: { statusCode: number; message: string }) => Object.assign(new Error(input.message), input))
  const definitions = await Promise.all(['preflight_roster_batch', 'save_roster_batch', 'preflight_roster_evidence_corrections', 'commit_roster_evidence_corrections'].map(async name => (await import(`../../../server/mcp/tools/${name}.ts`)).default))
  server = createServer((request, response) => {
    const mcp = new McpServer({ name: 'issue350', version: '1' })
    const mcpAuth = resolveMcpAuth({ given: readMcpToken({ authorization: request.headers.authorization }), configured: token })
    for (const tool of definitions.filter(tool => !tool.enabled || tool.enabled({ context: { mcpAuth } }))) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (input: Record<string, unknown>) => {
      const result = await tool.handler(input)
      return result.content ? result : 'isError' in result
        ? { ...result, content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }] }
        : { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); transports.add(transport)
    response.on('close', () => { transports.delete(transport); void mcp.close() })
    void mcp.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => { response.statusCode = 500; response.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  client = new Client({ name: 'issue350', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
})
afterAll(async () => {
  await client?.close(); for (const transport of transports) await transport.close()
  await importExecutor.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const handle of handles) if (handle.open) handle.close(); vi.unstubAllGlobals()
})
function row(over: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow {
  return { nameRaw: 'Published Alpha', usccRaw: null, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'Verified original declaration' }, storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(bytes), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified original row', ...over }
}
const append = (eventId: number, publishedRow = row()) => ({ eventId, recordId: eventId === 3 ? 2 : 1, enterpriseId: eventId === 3 ? 2 : 1, expectedVersion: (sqlite.prepare('SELECT revision FROM record_event WHERE id=?').get(eventId) as { revision: number }).revision, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: publishedRow.listNo, page: null, publishedRow } })
function request(payload: RosterImportPayload) { return { idempotencyKey: 'mcp-' + serial++, sourceKind: 'announcement', sourceIdentity: 'synthetic', payload } }
async function call(name: string, args: object): Promise<any> {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
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
  const tools = (await client.listTools()).tools
  const save = tools.find(tool => tool.name === 'save_roster_batch')!
  expect(JSON.stringify(save.inputSchema)).toContain('officialEvidenceAppends')
  expect(JSON.stringify(save.inputSchema)).toContain('publishedRow')
  expect(JSON.stringify(save.inputSchema)).toContain('expectedRowRevision')
  expect(JSON.stringify(save.inputSchema)).toContain('officialEvidencePlanHash')
})
it('commits compatible source associations and genuine same-key receipts through the real import process', async () => {
  const first = await commit({ officialEvidenceAppends: [append(1)] })
  const evidenceId = first.items.find((item: any) => item.kind === 'official_evidence').detail.evidence[0].evidenceId
  expect(readLatestOfficialEvidence(db, evidenceId).row).toMatchObject({ nameRaw: 'Published Alpha', eventId: 1 })
  await commit({ officialEvidenceAppends: [append(2, row({ nameRaw: null }))] })
  expect(sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 2 })
}, 10000)
async function seedPair() { await commit({ officialEvidenceAppends: [append(1)] }); await commit({ officialEvidenceAppends: [append(2, row({ nameRaw: null }))] }) }
it('rejects a cross-owner claim atomically through actual MCP preflight and worker commit', async () => {
  await seedPair()
  const input = request({ officialEvidenceAppends: [append(3)] })
  const plan = await call('preflight_roster_batch', input)
  expect(plan.preflight.conflicts[0].error.code).toBe('source_row_conflict')
  const saved = await call('save_roster_batch', input)
  expect(saved.status).toBe('failed')
  expect(sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
})
it('combines append and raw-only correction using one original event version and one CAS through MCP', async () => {
  await seedPair()
  const evidenceId = (sqlite.prepare('SELECT id FROM record_evidence WHERE record_event_id=1').get() as { id: number }).id
  const before = readExactEvidence(db, evidenceId), originalVersion = before.event.revision
  const publishedRow = row({ nameRaw: 'Explicit corrected raw' })
  const saved = await commit({ officialEvidenceAppends: [append(1, row({ listNo: 20 }))], officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Explicit correction', operations: [{ evidenceId, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: before.version, expectedRowRevision: 1, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }, publishedRow }] } })
  expect(readLatestOfficialEvidence(db, evidenceId).row).toMatchObject({ revision: 2, nameRaw: 'Explicit corrected raw' })
  expect(sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: originalVersion + 1 })
  const audit = db.select().from(schema.evidenceCorrectionAudit).all()[0]!
  expect(audit.batchKey).toBeNull(); expect(z.object({ importBatchId: z.number().int().positive() }).passthrough().parse(audit.after).importBatchId).toBe(saved.batchId)
})
it('rechecks the actual configured file bytes inside the import process after MCP preflight', async () => {
  await seedPair()
  const input = request({ officialEvidenceAppends: [append(1, row({ listNo: 30 }))] })
  const plan = await call('preflight_roster_batch', input); expect(plan.preflight.conflicts).toEqual([])
  writeFileSync(join(filesDir, 'notice.txt'), 'changed after preflight')
  const saved = await call('save_roster_batch', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } })
  expect(saved.status).toBe('failed'); expect(saved.items.some((item: any) => item.error?.code === 'file_changed')).toBe(true)
  expect(sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
})
it('rolls back a new independent declaration and append after a real worker SQLite failure', async () => {
  await seedPair()
  const independent = row({ declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'New separate publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Verified independent official publication' } })
  const input = request({ officialEvidenceAppends: [append(1, independent)] })
  const plan = await call('preflight_roster_batch', input); expect(plan.preflight.conflicts).toEqual([])
  sqlite.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON official_evidence_row_revision WHEN NEW.source_document_id<>1 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
  const result = await call('save_roster_batch', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } })
  expect(result.status).toBe('failed')
  expect(sqlite.prepare('SELECT count(*) n FROM source_document').get()).toEqual({ n: 1 })
  expect(sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
  expect(sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 2 })
  expect(sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 2 })
})
it('serializes competing MCP submissions and rejects the incompatible final source claim', async () => {
  const a = request({ officialEvidenceAppends: [append(1, row({ listNo: 30 }))] })
  const b = request({ officialEvidenceAppends: [append(3, row({ listNo: 30 }))] })
  const pa = await call('preflight_roster_batch', a), pb = await call('preflight_roster_batch', b)
  expect(pa.preflight.conflicts).toEqual([]); expect(pb.preflight.conflicts).toEqual([])
  const results = await Promise.all([
    call('save_roster_batch', { ...a, payload: { ...a.payload, officialEvidencePlanHash: pa.preflight.officialEvidencePlanHash } }),
    call('save_roster_batch', { ...b, payload: { ...b.payload, officialEvidencePlanHash: pb.preflight.officialEvidencePlanHash } }),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['committed', 'failed'])
  expect(results.find(result => result.status === 'failed').items.some((item: any) => item.error?.code === 'source_row_conflict')).toBe(true)
  expect(sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 1 })
})
