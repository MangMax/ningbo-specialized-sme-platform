import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import ExcelJS from 'exceljs'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serialize } from 'node:v8'
import { AT767, copy767, literalMembers767, prepare767 } from './helpers/current-worker-767'
import { CURRENT_TITLES, type CurrentTitle } from '../lib/roster/current-titles'
import { CURRENT_STATUS_LABELS, type CurrentStatus } from '../lib/roster/current-status'
import { CURRENT_HEADERS } from '../lib/roster/current-workbook'
import { CURRENT_RULE_VERSION, createCurrentQualificationAssessmentReader } from '../lib/roster/current-qualification'
import { currentWorkbookValues } from '../lib/roster/current-workbook-presentation'
import type { CurrentQualifiedFilter, CurrentQualifiedResult } from '../lib/roster/current-qualified-query'
import { enterpriseJsonChunks } from '../lib/roster/enterprise-read-json'
import { assertExpandRuntime } from '../db/schema-phase'
import { useDb } from '../db/client'
import { readOwnerIdentity } from '../lib/roster/offmain-read-protocol'
import { createEnterpriseReadExecutor } from '../server/utils/enterprise-read'
import { createEnterpriseWorker } from '../server/utils/enterprise-read-worker-location'
import { createCurrentExportWorker } from '../server/utils/current-export-worker-location'
import { createImportExecutionWorker } from '../server/utils/import-execution-worker-location'
import { createEnterpriseReadProcess } from '../server/utils/enterprise-read-process'
import { closeApplicationLogging } from '../lib/logging'
import { appendOfficialEvidenceRevision } from '../server/utils/official-evidence'
import { currentRosterExportSpec } from '../server/utils/jobs/current-roster-export'
import { createJob } from '../server/utils/job-store'
import { newJobId } from '../lib/job'

const evidence = process.env.CURRENT_WORKER_767_EVIDENCE
const fixtures = process.env.CURRENT_WORKER_767_FIXTURES
if (!evidence || !fixtures) throw new Error('Set private CURRENT_WORKER_767_EVIDENCE and CURRENT_WORKER_767_FIXTURES')
const root = mkdtempSync(join(evidence, 'workers767-'))
const baselines = process.env.CURRENT_WORKER_767_BASELINES!
if (!baselines) throw new Error('Set owned CURRENT_WORKER_767_BASELINES')
mkdirSync(baselines, { recursive: true })
const legacyList: typeof import('../lib/roster/current-qualified-query') = await import(join(evidence, 'legacy-list.ts'))
const legacyWorkbook: typeof import('../lib/roster/current-workbook') = await import(join(evidence, 'legacy-workbook.ts'))
let targetBase: string, oldBase: string
type Process = ReturnType<typeof createEnterpriseReadProcess>
const cleanup: Array<() => unknown | Promise<unknown>> = []
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const modes = ['source', 'bundle'] as const
type Mode = typeof modes[number]
let bundleRoot: string

beforeAll(async () => {
  ;({ targetBase, oldBase } = prepare767(fixtures, baselines))
  const original = join(root, 'artifact-original')
  mkdirSync(original)
  const { build } = createRequire(import.meta.resolve('nitropack/package.json'))('esbuild')
  const result = await build({
    absWorkingDir: resolve(import.meta.dirname, '..'),
    entryPoints: ['lib/roster/enterprise-read-worker.ts', 'lib/roster/current-export-worker.ts'],
    outdir: original, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node24', metafile: true, sourcemap: true,
    tsconfigRaw: { compilerOptions: { target: 'ESNext' } },
  })
  // Move the entire leaf artifact before use; the source launchers and Nitro
  // output are separate evidence lanes. Only external packages share deps.
  bundleRoot = join(root, 'relocated', 'leaf')
  mkdirSync(join(root, 'relocated'))
  renameSync(original, bundleRoot)
  symlinkSync(resolve('node_modules'), join(bundleRoot, 'node_modules'), 'dir')
  writeFileSync(join(root, 'bundle-inventory.json'), JSON.stringify({
    inputs: Object.fromEntries(Object.keys(result.metafile.inputs).map(path => [path, sha(resolve(path))])),
    outputs: Object.fromEntries(readdirSync(bundleRoot).filter(n => n !== 'node_modules').map(n => [n, sha(join(bundleRoot, n))])),
    originalAbsent: !existsSync(original), relocated: bundleRoot, spawnCwd: join(root, 'relocated'), lane: 'esbuild leaf; Nitro build UNRUN',
  }, null, 2))
}, 30000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
afterAll(async () => { await closeApplicationLogging() })
function clock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AT767)
}
function fixture() {
  clock()
  const dir = mkdtempSync(join(root, 'case-')), path = join(dir, 'target.sqlite'), oldPath = join(dir, 'old.sqlite')
  copy767(targetBase, path); copy767(oldBase, oldPath)
  const old = new Database(oldPath)
  cleanup.push(() => old.close())
  const check = new Database(path, { readonly: true })
  try {
    expect(check.pragma('user_version', { simple: true })).toBe(71613)
    expect(check.prepare("select name from sqlite_schema where name in ('platform_query','platform_relation')").all()).toEqual([])
  } finally { check.close() }
  return { dir, path, old, oldPath }
}
function relocatedProcess(entry: string) {
  const previous = process.cwd()
  try {
    process.chdir(join(root, 'relocated'))
    return createEnterpriseReadProcess(pathToFileURL(join(bundleRoot, entry)))
  } finally { process.chdir(previous) }
}
function reader(mode: Mode) {
  return mode === 'source' ? createEnterpriseWorker() : relocatedProcess('enterprise-read-worker.mjs')
}
function executor(mode: Mode = 'source') {
  const processes: Process[] = [], pids: number[] = [], exits: unknown[] = []
  const run = createEnterpriseReadExecutor({ createWorker() {
    const child = reader(mode); processes.push(child)
    child.on('message', message => { if (message.type === 'ready') pids.push(message.pid) })
    child.on('exit', (code, signal) => exits.push({ code, signal }))
    return child
  }, maxPending: 2 })
  cleanup.push(async () => {
    await run.close()
    writeFileSync(join(root, `lifecycle-${pids.join('-')}.json`), JSON.stringify({ pids, exits }))
  })
  return { run, processes, pids, exits }
}
async function request(child: Process, input: object) {
  const messages: any[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = new Promise<any>((yes, no) => {
    const onMessage = (message: any) => {
      messages.push(message)
      if (['result', 'failure', 'reader-error', 'done'].includes(message.type)) {
        child.removeListener('message', onMessage); clearTimeout(timer); yes({ message, messages })
      }
    }
    child.on('message', onMessage)
    timer = setTimeout(() => { child.removeListener('message', onMessage); no(new Error('767 IPC observation deadline')) }, 20000)
    child.postMessage(input)
  })
  try { return await result } finally { clearTimeout(timer) }
}
async function ready(child: Process) {
  cleanup.push(() => child.terminate())
  const [message] = await once(child, 'message')
  expect(message.type).toBe('ready')
  expect(message.pid).not.toBe(process.pid)
  expect(message.execArgv).toContain('--max-old-space-size=256')
  expect(message.execArgv).toContain('--max-semi-space-size=16')
}
function filters(titleCode: CurrentTitle): CurrentQualifiedFilter[] {
  return [
    ...Object.keys(literalMembers767).map(status => ({ titleCode, status: status as CurrentStatus, pageSize: 100 })),
    ...[{}, { district: '海曙区' }, { q: '旧名检索' }, { q: '9133020078041158x6' }, { q: 'missing' },
      { recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31' },
      { recognitionFrom: '2025-02-01', recognitionTo: '2025-12-31' },
      { validYear: 2028 }, { maintenanceYear: 2026 }, { maintenanceYear: 2026, maintenanceBatch: 2 },
      { validYear: 2029 }].map(filter => ({ titleCode, ...filter })),
    ...(['id_asc', 'name_asc', 'name_desc'] as const).flatMap(sort => [1, 2, 3].map(page => ({ titleCode, sort, page, pageSize: 1 }))),
  ]
}
it('767 default executor currentQualifiedJson uses the actual source launcher on the completed target', async () => {
  const f = fixture(), run = createEnterpriseReadExecutor()
  cleanup.push(() => run.close())
  const filter = { titleCode: 'little_giant' as const }
  const result = await run.currentQualifiedJson(f.path, filter)
  expect(result.found).toBe(true)
  expect(result.body).toEqual(Buffer.concat([...enterpriseJsonChunks(legacyList.listCurrentQualified(f.old, filter))]))
})

it.each(modes)('767 %s real executor JSON preserves three titles five states filters pagination full DTO native cells and byte order', async mode => {
  const f = fixture(), { run, pids } = executor(mode), before = sha(f.path)
  for (const title of CURRENT_TITLES) for (const filter of filters(title)) {
    const expected = legacyList.listCurrentQualified(f.old, filter)
    const actual = await run.currentQualifiedJson(f.path, filter)
    const bytes = Buffer.concat([...enterpriseJsonChunks(expected)])
    expect(actual.found).toBe(true)
    expect(actual.body.equals(bytes)).toBe(true)
    const dto = JSON.parse(actual.body.toString()) as CurrentQualifiedResult
    if (filter.status) expect(dto.rows.map(row => row.enterpriseId)).toEqual(literalMembers767[filter.status])
    for (const row of dto.rows) {
      expect(row.qualificationAssessment.titles).toHaveLength(3)
      expect(row.qualificationAssessment.snapshotId).toMatch(/^[a-f0-9]{64}$/)
    }
    if (title === 'specialized_sme' && !filter.status && !filter.page && Object.keys(filter).length === 1) {
      const row = dto.rows.find(row => row.enterpriseId === 760)!
      const native = row.qualificationAssessment.titles[1]!.platform.observations.flatMap(o => o.rows).find(row => row.relationId === 2004)!
      expect(native.status).toEqual({ 0: 0, 1: 255 })
    }
  }
  expect(pids).toHaveLength(1)
  expect(sha(f.path)).toBe(before)
}, 60000)

function shape(book: ExcelJS.Workbook) {
  return book.worksheets.map(sheet => ({
    name: sheet.name, views: sheet.views, autoFilter: sheet.autoFilter, columns: sheet.columns.map(c => c.width),
    rows: Array.from({ length: sheet.rowCount }, (_, i) => ({
      height: sheet.getRow(i + 1).height,
      cells: Array.from({ length: sheet.columnCount }, (_, c) => {
        const cell = sheet.getCell(i + 1, c + 1); return { value: cell.value, style: cell.style }
      }),
    })),
  }))
}
const receiptRuntime = { apiToken: 'WORKER767_API_TOKEN', mcpToken: 'WORKER767_MCP_TOKEN', ocrToken: 'WORKER767_OCR_TOKEN' }
const safeFailure = { type: 'failure', message: '当前名录导出执行失败；请核对数据或资源限制后重新提交' }
async function workbook(mode: Mode, path: string, title: CurrentTitle, temporaryPath: string, context: unknown = receiptRuntime, onProgress?: () => void) {
  const child = mode === 'source' ? createCurrentExportWorker() : relocatedProcess('current-export-worker.mjs')
  cleanup.push(() => child.terminate())
  const progress: any[] = []
  child.on('message', message => { if (message.type === 'progress') { progress.push(message); onProgress?.() } })
  const exited = once(child, 'exit')
  const response = await request(child, { dbPath: path, title, temporaryPath, jobId: '767-owned-job', receiptRuntime: context })
  expect(await exited).toEqual([1, null]) // Existing post-terminal disconnect contract.
  expect(response.messages.filter((m: any) => m.type === 'done' || m.type === 'failure')).toHaveLength(1)
  return { ...response, progress }
}
it.each(modes.flatMap(mode => CURRENT_TITLES.map(title => ({ mode, title }))))('767 $mode actual XLSX $title matches frozen schema0 every cell appendix and independent dataVersion with receipt runtime', async ({ mode, title }) => {
  const f = fixture()
  // Capture synthetic published names through the real append owner. Receipt
  // redaction owns published names; source locators retain their existing rules.
  for (const path of [f.path, f.oldPath]) {
    const db = new Database(path)
    const rows = db.prepare('select ev.id as evidenceId,e.id as eventId,r.id as recordId from record_evidence ev join record_event e on e.id=ev.record_event_id join record r on r.id=e.record_id where r.enterprise_id=770').all() as { evidenceId: number; eventId: number; recordId: number }[]
    const batchId = db.prepare('select id from import_batch order by id desc limit 1').pluck().get() as number
    for (const row of rows) appendOfficialEvidenceRevision(drizzle(db, { schema }), {
      evidenceId: row.evidenceId, eventId: row.eventId, capturedRecordId: row.recordId, capturedEnterpriseId: 770,
      nameRaw: '合成出处 ' + Object.values(receiptRuntime).join(' '), usccRaw: null, districtRaw: null,
      sourceDocumentId: null, storedFileId: null, path: null, sha256: null, bytes: null,
      attachment: null, sectionKey: null, listNo: null, page: null, sourceBindingKnown: false,
      actor: { type: 'agent', id: '767' }, basis: 'Synthetic published-name receipt boundary', command: { kind: 'import', batchId },
    }, 0)
    db.close()
  }
  const before = sha(f.path), file = join(f.dir, `${mode}.xlsx`), oldFile = join(f.dir, 'old.xlsx')
  const { message, progress } = await workbook(mode, f.path, title, file)
  expect(message.type).toBe('done')
  const expected = await legacyWorkbook.writeCurrentWorkbook(f.old, title, oldFile, () => {}, undefined, receiptRuntime)
  const { executor: metrics, ...result } = message.result
  expect(result).toEqual(expected)
  expect(metrics.heapLimitBytes).toBeLessThan(400 * 1024 ** 2)
  expect(result.statusCounts).toEqual({ effective: 2, expired: 1, terminated: 1, moved_out: 1, unrecognized: 1 })
  expect(progress[0]).toMatchObject({ done: 0, total: 6, snapshotId: '767-owned-job', ruleVersion: CURRENT_RULE_VERSION, snapshotStartedAt: new Date(AT767).toISOString() })
  const book = new ExcelJS.Workbook(), reference = new ExcelJS.Workbook()
  await book.xlsx.readFile(file); await reference.xlsx.readFile(oldFile)
  expect(shape(book)).toEqual(shape(reference))
  expect(book.worksheets.map(s => s.name)).toEqual([...Object.values(CURRENT_STATUS_LABELS), '长文本全文', '口径说明'])
  const hash = createHash('sha256').update(JSON.stringify(['current-export-assessment-409-v2', 'enterprise-qualification-687-v4', CURRENT_RULE_VERSION, 2026, title]) + '\n')
  const assessment = createCurrentQualificationAssessmentReader(f.old, receiptRuntime)
  for (const [status, name] of Object.entries(CURRENT_STATUS_LABELS) as [CurrentStatus, string][]) {
    const sheet = book.getWorksheet(name)!
    expect(sheet.getRow(1).values).toEqual([undefined, ...CURRENT_HEADERS])
    expect(sheet.rowCount).toBe(literalMembers767[status].length + 1)
    for (const [i, id] of literalMembers767[status].entries()) {
      const { rows, snapshot, workbookPublished } = assessment.readWorkbook(id, AT767, title)
      const row = rows.find(row => row.assessment!.titleCode === title)!, effective = row.assessment!.effectiveQualification!
      const values = [...currentWorkbookValues(title, row, i + 1, workbookPublished), name, (effective.presentationBasis ?? []).join('；'), effective.notes.join('；')]
      const { titles: _titles, snapshotId, ...scope } = snapshot
      hash.update(JSON.stringify([status, id, scope, snapshotId, values]) + '\n')
      for (const [column, value] of values.entries()) {
        const cell = sheet.getCell(i + 2, column + 1), parts: string[] = []
        book.getWorksheet('长文本全文')!.eachRow((r, n) => {
          if (n > 1 && r.getCell(1).value === name && r.getCell(2).value === cell.address) parts.push(String(r.getCell(12).value))
        })
        expect(parts.length ? parts.join('') : cell.value).toBe(parts.length ? value : value === '' ? null : value)
      }
    }
  }
  expect(result.dataVersion).toBe('sha256:' + hash.digest('hex'))
  for (const token of Object.values(receiptRuntime)) expect(JSON.stringify(shape(book))).not.toContain(token)
  expect(JSON.stringify(shape(book))).toContain('[REDACTED]')
  expect(sha(f.path)).toBe(before)
}, 30000)

it.each(modes)('767 %s same real worker current success noncurrent refusal current success and schema0 operations stay admitted', async mode => {
  const f = fixture(), child = reader(mode)
  await ready(child)
  const current = { dbPath: f.path, operation: 'current-qualified', filter: { titleCode: 'little_giant' } }
  expect((await request(child, { id: 1, ...current })).message.type).toBe('result')
  const owner = readOwnerIdentity(f.path)
  const operations = [
    { operation: 'list', filter: {} }, { operation: 'detail', enterpriseId: 760 },
    { operation: 'recognitions', owner, filter: {} }, { operation: 'differences', owner, filter: {} },
    { operation: 'summary', owner, options: {} },
  ]
  for (const [i, operation] of operations.entries()) {
    expect((await request(child, { id: 10 + i, dbPath: f.path, ...operation })).message.type).toBe('failure')
    expect((await request(child, { id: 20 + i, ...current })).message.type).toBe('result')
  }
  for (const [i, operation] of operations.entries()) {
    const response = await request(child, { id: 40 + i, dbPath: f.oldPath, ...operation, ...('owner' in operation ? { owner: readOwnerIdentity(f.oldPath) } : {}) })
    expect(response.message.type).toBe('result')
  }
}, 30000)

it.each([71609, 71610, 71611, 71612, 71614])('767 real source workers reject intermediate or unsupported phase %i without modifying DB', async phase => {
  const f = fixture(), db = new Database(f.path)
  // Negative controls only. No admitted fixture is made by changing user_version.
  db.pragma(`user_version=${phase}`); db.close()
  const before = sha(f.path), { run } = executor()
  await expect(run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  expect((await workbook('source', f.path, 'little_giant', join(f.dir, 'rejected.xlsx'))).message).toEqual(safeFailure)
  expect(sha(f.path)).toBe(before)
}, 30000)

it.each(['candidate-scope-offline-v1', 'recognized-witness-offline-v1', 'process-exact-stored-offline-v1', 'collection-legacy-provenance-v1'])('767 real source workers reject unfinished %s before returning data', async transform => {
  const f = fixture(), db = new Database(f.path)
  expect(db.prepare("update platform_migration_run set state='running' where transform_version=?").run(transform).changes).toBeGreaterThan(0)
  db.close()
  const before = sha(f.path), { run } = executor()
  await expect(run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  expect((await workbook('source', f.path, 'little_giant', join(f.dir, 'unfinished.xlsx'))).message).toEqual(safeFailure)
  expect(sha(f.path)).toBe(before)
}, 30000)

it.each(modes)('767 %s explicit legacy target refusal leaves schema0 source semantics and global guards closed', async mode => {
  const f = fixture()
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE', 'legacy')
  const { run } = executor(mode)
  await expect(run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  expect((await workbook(mode, f.path, 'little_giant', join(f.dir, 'legacy.xlsx'))).message).toEqual(safeFailure)
  const old = await run.currentQualifiedJson(f.oldPath, { titleCode: 'little_giant' })
  expect(old.body).toEqual(Buffer.concat([...enterpriseJsonChunks(legacyList.listCurrentQualified(f.old, { titleCode: 'little_giant' }))]))
  const db = new Database(f.path, { readonly: true })
  try { expect(() => assertExpandRuntime(db)).toThrow('W/R cutover required') } finally { db.close() }
  expect(() => useDb({ dbPath: f.path, readOnly: true })).toThrow('W/R cutover required')
}, 30000)

it('767 actual import worker still rejects completed target before deserializing a command', async () => {
  const f = fixture(), db = new Database(f.path, { readonly: true }), stat = statSync(f.path)
  const identity = { dev: stat.dev, ino: stat.ino, schemaVersion: db.pragma('schema_version', { simple: true }), migration: db.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() }
  db.close()
  const before = sha(f.path), child = createImportExecutionWorker()
  cleanup.push(() => child.terminate())
  expect((await once(child, 'message'))[0].type).toBe('ready')
  const response = await request(child, { id: 1, dbPath: f.path, readonly: true, identity, action: 'preflight', payload: serialize({}), pageCountErrors: [] })
  expect(response.message.type).toBe('failure')
  expect(response.message.error.message).toContain('W/R cutover required')
  expect(sha(f.path)).toBe(before)
}, 30000)

it.each(modes)('767 %s invalid receipt runtime is closed and redacted at actual export IPC boundary', async mode => {
  const f = fixture(), file = join(f.dir, 'invalid.xlsx')
  const response = await workbook(mode, f.path, 'little_giant', file, { extra: 'PRIVATE767_TOKEN' })
  expect(response.message).toEqual(safeFailure)
  expect(response.progress).toEqual([])
  expect(existsSync(file)).toBe(false)
})

it('767 same real worker refreshes owner on same path replacement and recovers after refusal', async () => {
  const f = fixture(), { run, pids } = executor()
  expect((await run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).found).toBe(true)
  const replaced = join(f.dir, 'replacement.sqlite')
  copy767(oldBase, replaced); renameSync(replaced, f.path)
  expect((await run.list(f.path)).rows.length).toBeGreaterThan(0)
  copy767(targetBase, replaced); renameSync(replaced, f.path)
  await expect(run.list(f.path)).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  expect((await run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).found).toBe(true)
  expect(pids).toHaveLength(1)
})

it.each(modes)('767 %s cached connection rechecks phase and completion on every current request', async mode => {
  const f = fixture(), { run, pids } = executor(mode)
  const read = () => run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })
  expect((await read()).found).toBe(true)
  const writer = new Database(f.path)
  cleanup.push(() => writer.close())
  writer.pragma('user_version=71612')
  await expect(read()).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  writer.pragma('user_version=71613')
  expect((await read()).found).toBe(true)
  writer.exec("update platform_migration_run set state='running' where transform_version='collection-legacy-provenance-v1'")
  await expect(read()).rejects.toMatchObject({ code: 'enterprise_read_failed' })
  writer.exec("update platform_migration_run set state='complete' where transform_version='collection-legacy-provenance-v1'")
  expect((await read()).found).toBe(true)
  expect(pids).toHaveLength(1)
})

function assignment(path: string) {
  const db = new Database(path)
  try { db.prepare("insert into platform_observation_assignment(observation_id,revision,enterprise_id,uscc_raw,match_basis,verification_status,origin,basis) values(2004,2,761,NULL,'manual','pending','command','767 concurrent assignment')").run() }
  finally { db.close() }
}
function barrier(dir: string) {
  const release = join(dir, 'release')
  vi.stubEnv('CURRENT767_BARRIER', release)
  return release
}
function boundary(release: string) {
  return new Promise<void>((yes, no) => {
    const watcher = watch(resolve(release, '..'), () => {
      if (existsSync(release + '.ready')) { clearTimeout(timer); watcher.close(); yes() }
    })
    const timer = setTimeout(() => { watcher.close(); no(new Error('767 real SQL boundary deadline')) }, 20000)
    if (existsSync(release + '.ready')) { clearTimeout(timer); watcher.close(); yes() }
  })
}
it('767 real child request snapshot survives concurrent assignment and next request sees it', async () => {
  const f = fixture(), writer = new Database(f.path)
  writer.pragma('journal_mode=WAL'); writer.close()
  const release = barrier(f.dir), child = reader('source')
  await ready(child)
  const seen = boundary(release)
  const first = request(child, { id: 1, dbPath: f.path, operation: 'current-qualified', filter: { titleCode: 'specialized_sme', pageSize: 100 } })
  await seen
  assignment(f.path); writeFileSync(release, 'committed')
  const firstResult = await first
  const bytes = Buffer.concat(firstResult.messages.filter((m: any) => m.type === 'chunk').map((m: any) => m.payload))
  expect(bytes).toEqual(Buffer.concat([...enterpriseJsonChunks(legacyList.listCurrentQualified(f.old, { titleCode: 'specialized_sme', pageSize: 100 }))]))
  const next = await request(child, { id: 2, dbPath: f.path, operation: 'current-qualified', filter: { titleCode: 'specialized_sme', pageSize: 100 } })
  const nextDto = JSON.parse(Buffer.concat(next.messages.filter((m: any) => m.type === 'chunk').map((m: any) => m.payload)).toString()) as CurrentQualifiedResult
  expect(nextDto.rows[0]!.qualificationAssessment.titles[1]!.platform.observations.flatMap(o => o.rows).map(r => r.relationId)).not.toContain(2004)
  const unrecognized = await request(child, { id: 3, dbPath: f.path, operation: 'current-qualified', filter: { titleCode: 'specialized_sme', status: 'unrecognized', pageSize: 100 } })
  const dto = JSON.parse(Buffer.concat(unrecognized.messages.filter((m: any) => m.type === 'chunk').map((m: any) => m.payload)).toString())
  expect(dto.rows.map((r: any) => r.enterpriseId)).toEqual([761, 774])
}, 30000)

it('767 real asynchronous export pins concurrent assignment through XLSX commit and next export refreshes', async () => {
  const f = fixture(), writer = new Database(f.path)
  writer.pragma('journal_mode=WAL'); writer.close()
  const release = barrier(f.dir), seen = boundary(release)
  const first = workbook('source', f.path, 'specialized_sme', join(f.dir, 'snapshot.xlsx'))
  await seen
  assignment(f.path); writeFileSync(release, 'committed')
  const original = await first
  expect(original.message.type).toBe('done')
  const reference = await legacyWorkbook.writeCurrentWorkbook(f.old, 'specialized_sme', join(f.dir, 'reference.xlsx'), () => {}, undefined, receiptRuntime)
  expect(original.message.result.dataVersion).toBe(reference.dataVersion)
  const book = new ExcelJS.Workbook(), old = new ExcelJS.Workbook()
  await book.xlsx.readFile(join(f.dir, 'snapshot.xlsx')); await old.xlsx.readFile(join(f.dir, 'reference.xlsx'))
  expect(shape(book)).toEqual(shape(old))
  const next = await workbook('source', f.path, 'specialized_sme', join(f.dir, 'next.xlsx'))
  expect(next.message.type).toBe('done')
  expect(next.message.result.total).toBe(original.message.result.total + 1)
  expect(next.message.result.dataVersion).not.toBe(original.message.result.dataVersion)
  expect(next.message.result.statusCounts.unrecognized).toBe(2)
}, 30000)

it.each(['abort', 'kill'] as const)('767 actual executor %s settles active request preserves FIFO and restarts a clean OS process', async action => {
  const f = fixture(), release = barrier(f.dir), { run, processes, pids, exits } = executor()
  await run.start()
  const seen = boundary(release), abort = new AbortController()
  const active = run.currentQualifiedJson(f.path, { titleCode: 'little_giant' }, abort.signal)
  const settled = active.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error }))
  await seen
  const cancelled = new AbortController()
  const removed = run.currentQualifiedJson(f.path, { titleCode: 'little_giant' }, cancelled.signal)
  const removedRejected = expect(removed).rejects.toMatchObject({ name: 'AbortError' })
  cancelled.abort(); await removedRejected
  const order: string[] = []
  const queued = run.currentQualifiedJson(f.path, { titleCode: 'innovative_sme' }).then(result => { order.push('innovative_sme'); return result })
  const queuedNext = run.currentQualifiedJson(f.path, { titleCode: 'specialized_sme' }).then(result => { order.push('specialized_sme'); return result })
  await expect(run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).rejects.toMatchObject({ code: 'enterprise_read_busy' })
  if (action === 'abort') abort.abort()
  else process.kill(pids[0]!, 'SIGKILL')
  const outcome = await settled
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind !== 'rejected') throw new Error('Expected terminated active request to reject')
  expect(outcome.error).toMatchObject(action === 'abort' ? { name: 'AbortError' } : { code: 'worker_exited' })
  writeFileSync(release, 'release future requests')
  const a = await queued, b = await queuedNext
  expect(JSON.parse(a.body.toString()).titleCode).toBe('innovative_sme')
  expect(JSON.parse(b.body.toString()).titleCode).toBe('specialized_sme')
  expect(order).toEqual(['innovative_sme', 'specialized_sme'])
  expect(pids).toHaveLength(2); expect(pids[1]).not.toBe(pids[0])
  expect(exits).toContainEqual({ code: null, signal: 'SIGKILL' })
  await run.close()
  await expect(run.currentQualifiedJson(f.path, { titleCode: 'little_giant' })).rejects.toMatchObject({ code: 'executor_closed' })
}, 30000)

it('767 real export cancellation terminates child and next source export succeeds with owned temporary cleanup', async () => {
  const f = fixture(), release = barrier(f.dir), child = createCurrentExportWorker(), file = join(f.dir, 'cancelled.part')
  const seen = boundary(release), exited = once(child, 'exit')
  child.postMessage({ dbPath: f.path, title: 'little_giant', temporaryPath: file, jobId: 'cancelled767' })
  await seen
  await child.terminate()
  expect(await exited).toEqual([null, 'SIGKILL'])
  writeFileSync(release, 'subsequent export')
  // Parent/job owns unlink of private output and process TMP after fatal stop.
  const { rmSync } = await import('node:fs')
  rmSync(file, { force: true })
  expect(existsSync(file)).toBe(false)
  expect((await workbook('source', f.path, 'little_giant', join(f.dir, 'restarted.xlsx'))).message.type).toBe('done')
  expect(readdirSync(process.env.TMPDIR!).filter(n => n.startsWith('enterprise-read-bootstrap-'))).toEqual([])
}, 30000)

it('767 actual parent export job cancels its real child removes private artifacts and runs a subsequent job', async () => {
  const f = fixture(), native = new Database(f.path), db = drizzle(native, { schema })
  cleanup.push(() => native.close())
  // WAL lets the unchanged parent job write its checkpoint while the real
  // export child's read snapshot is held at the observation boundary.
  native.pragma('journal_mode=WAL')
  const release = barrier(f.dir), seen = boundary(release), jobId = newJobId()
  const params = { titleCode: 'little_giant', clientRequestId: 'parent-cancel767' }
  createJob(db, { id: jobId, kind: currentRosterExportSpec.kind, params })
  let cancelled = false
  const run = currentRosterExportSpec.run
  if (!run) throw new Error('Current export job must have its real run owner')
  const completion = run({ db, jobId, filesDir: f.dir, progress() {}, cancelled: () => cancelled }, params)
  await seen
  cancelled = true
  const result = await completion
  expect(result.cancelled).toBe(true)
  expect(result.error).toBeUndefined()
  const exports = f.path + '.exports'
  expect(existsSync(join(exports, jobId + '.part'))).toBe(false)
  expect(existsSync(join(exports, jobId + '.xlsx'))).toBe(false)
  writeFileSync(release, 'next real job')
  const nextId = newJobId()
  createJob(db, { id: nextId, kind: currentRosterExportSpec.kind, params: { ...params, clientRequestId: 'parent-next767' } })
  const next = await run({ db, jobId: nextId, filesDir: f.dir, progress() {}, cancelled: () => false }, params)
  expect(next.error).toBeUndefined()
  expect(next.cancelled).not.toBe(true)
  expect(next.result).toMatchObject({ phase: 'complete', total: 6, artifact: { id: nextId, availability: 'available' } })
  expect(existsSync(join(exports, nextId + '.part'))).toBe(false)
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(join(exports, nextId + '.xlsx'))
  expect(book.getWorksheet('有效企业')!.rowCount).toBe(3)
  expect(readdirSync(process.env.TMPDIR!).filter(n => n.startsWith('enterprise-read-bootstrap-'))).toEqual([])
}, 30000)
