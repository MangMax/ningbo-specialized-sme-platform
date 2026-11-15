import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../../../lib/roster/current-qualification'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb, schema } from '../../../db/client'
import { captureReceiptRuntimeContext, validateReceiptRuntimeContext } from '../../../server/utils/receipt-runtime-context'
import { importReceiptRedactor } from '../../../server/utils/import-receipt-redaction'
import { createCurrentQualificationAssessmentReader, readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'
import { readOfficialPublishedPresentation } from '../../../lib/roster/official-published-presentation'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { createCurrentExportWorker } from '../../../server/utils/current-export-worker-location'
import { createEnterpriseReadProcess } from '../../../server/utils/enterprise-read-process'
import { preflightRosterImport, commitRosterImport } from '../../../server/utils/roster-import'
import type { RosterImportRequest } from '../../../lib/roster-import-client'
import { minimalPdf } from '../../helpers/minimal-pdf'
import { HEADERS_409 } from '../../fixtures/current-export-409'

let root: string, db: ReturnType<typeof initializeDb>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(),'runtime-context-409-'))
  db = initializeDb({ create: true, dbPath:join(root,'synthetic.db')})
  vi.stubEnv('NUXT_LOG_DIR',join(root,'logs'))
  for (const key of ['NUXT_API_TOKEN','NUXT_MCP_TOKEN','MIIT_COOKIE','NUXT_OCR_TOKEN','PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN']) vi.stubEnv(key,'')
})
afterEach(() => { vi.unstubAllEnvs(); db.$client.close(); rmSync(root,{recursive:true,force:true}) })
const saved = (key: 'miitCookie'|'ocrToken', value: string) => db.insert(schema.serviceCredential).values({key,value,updatedAt:'synthetic'}).run()
const apply = (r: ReturnType<typeof importReceiptRedactor>, nameRaw: string | null) => r({evidenceId:1,eventId:2,revision:1,availability:'captured',nameRaw,sourceBindingKnown:true},'official_published_name')

it('B02 preserves literal union order and omits unused runtime OCR with saved credentials', () => {
  vi.stubEnv('NUXT_API_TOKEN','E_API'); vi.stubEnv('NUXT_MCP_TOKEN','E_MCP')
  saved('miitCookie','S_COOKIE'); saved('ocrToken','S_OCR')
  const r = importReceiptRedactor(db,{additionalSecrets:['ADD']},{apiToken:'R_API',mcpToken:'R_MCP',ocrToken:'UNUSED_R_OCR'})
  expect(r.knownRedactors).toHaveLength(7)
  const literals = ['ADD','R_API','R_MCP','E_API','E_MCP','S_COOKIE','S_OCR']
  for (const [index, literal] of literals.entries()) {
    expect(String(r.knownRedactors[index]!(literal))).not.toContain(literal)
    expect(String(apply(r,literal))).not.toContain(literal)
  }
  expect(apply(r,'UNUSED_R_OCR')).toBe('UNUSED_R_OCR')
})
it.each([
  {id:'runtime',runtime:'  R_OCR  ',env:'E_OCR',paddle:'P_OCR',selected:'R_OCR',unused:['E_OCR','P_OCR']},
  {id:'env',runtime:'  ',env:' E_OCR ',paddle:'P_OCR',selected:'E_OCR',unused:['P_OCR']},
  {id:'paddle',runtime:'',env:' ',paddle:' P_OCR ',selected:'P_OCR',unused:[]},
])('B03 OCR precedence $id', ({runtime,env,paddle,selected,unused}) => {
  vi.stubEnv('NUXT_OCR_TOKEN',env); vi.stubEnv('PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN',paddle)
  const r=importReceiptRedactor(db,{}, {ocrToken:runtime})
  expect(String(apply(r,selected))).not.toContain(selected)
  for (const value of unused) expect(apply(r,value)).toBe(value)
})
it('B04 preserves empty filtering duplicate order and independent environment API sources', () => {
  vi.stubEnv('NUXT_API_TOKEN','ENV_API'); vi.stubEnv('MIIT_COOKIE',' COOKIE_ENV ')
  const r=importReceiptRedactor(db,{additionalSecrets:['DUP','','DUP']},{apiToken:'DUP',mcpToken:''})
  expect(r.knownRedactors).toHaveLength(3)
  for (const [i,value] of ['DUP','ENV_API','COOKIE_ENV'].entries()) expect(String(r.knownRedactors[i]!(value))).not.toContain(value)
})
it('B07 preserves typed name structural fields null and custom callback compatibility', () => {
  const r=importReceiptRedactor(db,{}, {apiToken:'SECRET'})
  expect(apply(r,null)).toBeNull()
  expect(apply(r,'SECRET企业')).not.toContain('SECRET')
  expect(r({evidenceId:1,nameRaw:'ordinary',apiToken:'SECRET'})).toEqual({evidenceId:1,nameRaw:'ordinary',apiToken:'[REDACTED]'})
  const enterprise=db.insert(schema.enterprise).values({name:'Container',nameNorm:'Container'}).returning().get()
  const record=db.insert(schema.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',nameRaw:'Container'}).returning().get()
  const event=db.insert(schema.recordEvent).values({recordId:record.id,eventType:'award',year:2026,batchSeq:1}).returning().get()
  const evidence=db.insert(schema.recordEvidence).values({recordEventId:event.id,sourceFile:'synthetic409.pdf'}).returning().get()
  const batch=db.insert(schema.importBatch).values({idempotencyKey:'B07',sourceKind:'announcement',sourceIdentity:'synthetic409',status:'committed'}).returning().get()
  db.insert(schema.officialEvidenceRowRevision).values({evidenceId:evidence.id,eventId:event.id,revision:1,capturedRecordId:record.id,capturedEnterpriseId:enterprise.id,nameRaw:'SECRET',path:'synthetic409.pdf',sourceBindingKnown:false,actor:{type:'agent',id:'synthetic409'},basis:'synthetic409',commandKind:'import',importBatchId:batch.id,createdAt:'synthetic409'}).run()
  const callback=vi.fn(()=> 'custom') as unknown as ReturnType<typeof importReceiptRedactor>
  const facts=readOfficialPublishedPresentation(db,[{evidenceId:evidence.id,eventId:event.id}],callback)
  expect(facts.get(evidence.id)).toEqual({evidenceId:evidence.id,eventId:event.id,revision:1,availability:'captured',nameRaw:'custom',sourceBindingKnown:false})
  expect(callback).toHaveBeenCalledWith({evidenceId:evidence.id,eventId:event.id,revision:1,availability:'captured',nameRaw:'SECRET',sourceBindingKnown:false},'official_published_name')
  const owned=readOfficialPublishedPresentation(db,[{evidenceId:evidence.id,eventId:event.id}],undefined,{apiToken:'SECRET'})
  expect(owned.get(evidence.id)).toMatchObject({evidenceId:evidence.id,eventId:event.id,revision:1,availability:'captured',sourceBindingKnown:false})
  expect(owned.get(evidence.id)!.nameRaw).not.toContain('SECRET')
})
it('B08 omitted and empty context keep default full three title DTO and digest', () => {
  const e=db.insert(schema.enterprise).values({name:'literal',nameNorm:'literal'}).returning().get()
  const at=Date.parse('2026-06-01T00:00:00Z')
  const expected=readCurrentQualificationAssessment(db.$client,e.id,at)
  expect(createCurrentQualificationAssessmentReader(db.$client).read(e.id,at).snapshot).toEqual(expected)
  expect(createCurrentQualificationAssessmentReader(db.$client,{}).read(e.id,at).snapshot).toEqual(expected)
  expect(importReceiptRedactor(db)('ordinary')).toBe(importReceiptRedactor(db,{})('ordinary'))
  expect(captureReceiptRuntimeContext({apiToken:'',ocrToken:undefined,unrelated:'not copied'})).toEqual({apiToken:''})
})
it('B06 credential storage fault retains safe failure without credential contents', () => {
  db.$client.exec('drop table service_credential')
  expect(()=>importReceiptRedactor(db,{}, {apiToken:'SYNTHETIC_NO_LEAK'})).toThrow('凭据配置存储不可用，请检查数据库后重试。')
})
it.each([
  {id:'null',value:null},{id:'array',value:[]},{id:'unknown',value:{extra:'literal'}},
  {id:'number',value:{apiToken:1}},{id:'undefined',value:{apiToken:undefined}},
  {id:'symbol',value:{[Symbol('synthetic')]:''}},
  {id:'accessor',value:Object.defineProperty({},'apiToken',{enumerable:true,get(){throw new Error('must not read')}})},
  {id:'oversize_ascii',value:{apiToken:'x'.repeat(16385)}},
  {id:'oversize_utf8',value:{apiToken:'中'.repeat(5462)}},
  {id:'json_escape',value:{apiToken:'\u0000'.repeat(16384)}},
])('B09 rejects closed context $id with fixed error', ({value}) => {
  expect(()=>validateReceiptRuntimeContext(value)).toThrow(/^导出运行上下文不可用$/)
})
it('B09 accepts exact UTF8 and total transport boundaries without truncation', () => {
  const input={apiToken:'a'.repeat(16384),mcpToken:'b'.repeat(16384),ocrToken:'c'.repeat(16384)}
  const value=validateReceiptRuntimeContext(input)
  expect(value).toEqual(input); expect(Object.isFrozen(value)).toBe(true)
  expect(validateReceiptRuntimeContext({apiToken:'中'.repeat(5461)+'a'}).apiToken).toHaveLength(5462)
})

// Actual child boundary controls. Literal tokens never overlap or come from real credentials.
const W409 = {
  runtimeApi: 'RA409A01', runtimeMcp: 'RM409B02', runtimeOcr: 'RO409C03',
  envApi: 'EA409D04', envMcp: 'EM409E05', envOcr: 'EO409F06', paddle: 'PO409G07',
  savedCookie: 'SC409H08', savedOcr: 'SO409J09', envCookie: 'EC409K10',
} as const
const W409_NAMES = { eligible: '真实worker有效主体', pending: '真实worker待核主体', excluded: '真实worker失败主体' }
const W409_RAW_NAME = '合成公布 ' + Object.values(W409).join(' ') + ' 企业'
const W409_SAFE_FAILURE = '当前名录导出执行失败；请核对数据或资源限制后重新提交'
const workerModes409 = ['source','compiled'] as const
const ocrPartitions409 = [
  { id: 'saved', runtimeOcr: W409.runtimeOcr, envOcr: W409.envOcr, savedOcr: true, savedCookie: true, selectedOcr: W409.savedOcr },
  { id: 'runtime', runtimeOcr: '  ' + W409.runtimeOcr + '  ', envOcr: W409.envOcr, savedOcr: false, savedCookie: false, selectedOcr: W409.runtimeOcr },
  { id: 'env', runtimeOcr: '  ', envOcr: ' ' + W409.envOcr + ' ', savedOcr: false, savedCookie: true, selectedOcr: W409.envOcr },
  { id: 'paddle', runtimeOcr: '', envOcr: ' ', savedOcr: false, savedCookie: false, selectedOcr: W409.paddle },
] as const

// Compile only this worker's current local dependency closure, never a previous app output.
// The packaged-app/Nitro lane remains a separate integration check.
const workerArtifactRoot409 = mkdtempSync(join(tmpdir(),'runtime-context-409-artifact-'))
const workerArtifactEntry409 = join(workerArtifactRoot409,'current-export-worker.mjs')
let artifactManifestSha409 = ''
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname,'../../..')
  const require = createRequire(import.meta.resolve('nitropack/package.json'))
  const { build } = require('esbuild')
  symlinkSync(join(cwd,'node_modules'),join(workerArtifactRoot409,'node_modules'),'dir')
  const result = await build({ absWorkingDir: cwd, entryPoints: ['lib/roster/current-export-worker.ts'], outfile: workerArtifactEntry409, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: true, metafile: true })
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const manifest = { inputs: Object.fromEntries(Object.keys(result.metafile!.inputs).map(path => [resolve(cwd,path),hash(resolve(cwd,path))])), outputs: Object.fromEntries([workerArtifactEntry409,workerArtifactEntry409 + '.map'].map(path => [path,hash(path)])) }
  const raw = JSON.stringify(manifest)
  artifactManifestSha409 = createHash('sha256').update(raw).digest('hex')
  writeFileSync(join(workerArtifactRoot409,'inventory.json'),raw,{ mode: 0o600 })
},30000)
afterAll(() => rmSync(workerArtifactRoot409,{ recursive: true, force: true }))
function assertWorkerArtifactPins409() {
  const raw = readFileSync(join(workerArtifactRoot409,'inventory.json'))
  expect(createHash('sha256').update(raw).digest('hex')).toBe(artifactManifestSha409)
  const inventory = JSON.parse(raw.toString()) as { inputs: Record<string,string>; outputs: Record<string,string> }
  expect(Object.keys(inventory.inputs)).toContain(resolve(import.meta.dirname,'../../../lib/roster/current-export-worker.ts'))
  expect(Object.keys(inventory.outputs)).toEqual([workerArtifactEntry409,workerArtifactEntry409 + '.map'])
  for (const [path,sha256] of Object.entries({ ...inventory.inputs, ...inventory.outputs })) expect(createHash('sha256').update(readFileSync(path)).digest('hex'),path).toBe(sha256)
}

function legalWorkerSeed409() {
  const filesDir = join(root,'files'); mkdirSync(filesDir)
  const source = minimalPdf({ pages: 1 }), path = 'B409合成公布.pdf'
  writeFileSync(join(filesDir,path),source)
  const sha256 = createHash('sha256').update(source).digest('hex'), bytes = Buffer.byteLength(source)
  const file = db.insert(schema.storedFile).values({ relPath: path, filename: path, ext: 'pdf', source: 'jxj', kind: 'announcement', sha256, bytes, createdAt: '2026-01-01T00:00:00Z' }).returning().get()
  const document = { source: 'jxj' as const, title: 'B409合成公布' }
  const request: RosterImportRequest = {
    idempotencyKey: 'actual-worker-409-legal-capture', sourceKind: 'announcement', sourceIdentity: 'B409合成公布',
    payload: { announcement: { sourceDocument: document, records: [{
      enterprise: { name: W409_NAMES.eligible, uscc: '91330211255994457P' }, titleCode: 'specialized_sme',
      events: [{ eventType: 'award', year: 2026, batchSeq: 1, evidence: [{ sourceFile: path, attachment: null, page: 1, listNo: 1, publishedRow: {
        nameRaw: W409_RAW_NAME, usccRaw: '91330211255994457P', districtRaw: null,
        declaration: { kind: 'independent', sourceDocument: { ...document, path, docNumber: null, issueDate: null }, basis: '合成独立发布依据' },
        storedFileId: file.id, path, sha256, bytes, attachment: null, sectionKey: '认定名单', listNo: 1, page: 1,
        sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic409' }, basis: '合成逐行核实',
      } }] }],
    }] } },
  }
  const plan = preflightRosterImport(db,request,[],{ filesDir })
  expect(plan.preflight.conflicts).toEqual([])
  request.payload = { ...request.payload, ...(plan.preflight.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } : {}) }
  expect(commitRosterImport(db,request,[],{ filesDir, deferCandidateTasks: true }).status).toBe('committed')
  const evidence = db.select().from(schema.recordEvidence).get()!
  expect(readOfficialPublishedPresentation(db,[{ evidenceId: evidence.id, eventId: evidence.recordEventId }]).get(evidence.id)).toMatchObject({ availability: 'captured', revision: 1, nameRaw: W409_RAW_NAME, sourceBindingKnown: true })
  for (const [name, outcome] of [[W409_NAMES.pending, null], [W409_NAMES.excluded, 'failed']] as const) {
    const enterprise = db.insert(schema.enterprise).values({ name, nameNorm: name }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: name }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2022, batchSeq: 1, decidedYear: outcome === null ? null : 2025, reviewOutcome: outcome }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: path, listNo: enterprise.id }).run()
  }
}

function workerBusinessDigest409() {
  const hash = createHash('sha256')
  for (const table of ['enterprise','record','record_event','record_evidence','official_evidence_row_revision','stored_file']) {
    const order = table === 'official_evidence_row_revision' ? 'evidence_id, revision' : 'id'
    for (const row of db.$client.prepare('select * from ' + table + ' order by ' + order).iterate()) hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}

async function actualWorker409(mode: typeof workerModes409[number], context: unknown, caseId: string) {
  assertWorkerArtifactPins409()
  const temporaryPath = join(root,'private.part'), finalPath = join(root,'published.xlsx')
  const worker = mode === 'source' ? createCurrentExportWorker() : createEnterpriseReadProcess(pathToFileURL(workerArtifactEntry409))
  const progress: Record<string, unknown>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let finalCount = 0
  type Terminal = { type: 'done'; result: { counts: { eligible: number; pending: number; excluded: number }; statusCounts: { effective: number; expired: number; terminated: number; moved_out: number; unrecognized: number }; total: number; generatedAt: string } } | { type: 'failure'; message: string }
  const terminal = new Promise<Terminal>((resolve, reject) => {
    worker.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'progress') progress.push(message)
      else if (message.type === 'done' || message.type === 'failure') { finalCount++; resolve(message as Terminal) }
      else reject(new Error('Unexpected worker protocol message'))
    })
    worker.on('error', reject)
    worker.once('exit', () => { if (!finalCount) reject(new Error('Worker exited without terminal protocol')) })
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => worker.once('exit', (code,signal) => resolve({ code,signal })))
  const deadline = new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error('409 test observation deadline')),20000) })
  try {
    // JSON roundtrip restricts these actual controls to values expressible on startup IPC.
    worker.postMessage({ dbPath: join(root,'synthetic.db'), title: 'specialized_sme', temporaryPath, jobId: 'actual-worker-409', receiptRuntime: JSON.parse(JSON.stringify(context)) })
    const [message,exit] = await Promise.race([Promise.all([terminal,exited]),deadline])
    expect(finalCount).toBe(1)
    // Existing child disconnect handler deliberately exits1 after its terminal message.
    expect(exit).toEqual({ code: 1, signal: null })
    const receipt = { caseId, mode, terminal: message.type, exit, progressCount: progress.length, privatePartPresent: existsSync(temporaryPath), privatePartBytes: existsSync(temporaryPath) ? statSync(temporaryPath).size : null, publishedPresent: existsSync(finalPath) }
    if (process.env.ISSUE409_WORKER_RECEIPTS) appendFileSync(process.env.ISSUE409_WORKER_RECEIPTS,JSON.stringify(receipt) + '\n',{ mode: 0o600 })
    expect(existsSync(finalPath)).toBe(false)
    return { message, progress, temporaryPath }
  } finally {
    clearTimeout(timer)
    await worker.terminate() // Await actual child exit before original afterEach deletes its DB.
    assertWorkerArtifactPins409()
  }
}

it.each(workerModes409.flatMap(mode => ocrPartitions409.map(partition => ({ mode, ...partition }))))('B3 actual worker $mode OCR $id literal cells', async partition => {
  legalWorkerSeed409()
  for (const a of Object.values(W409)) for (const b of Object.values(W409)) if (a !== b) expect(a.includes(b)).toBe(false)
  if (partition.savedCookie) saved('miitCookie',W409.savedCookie)
  if (partition.savedOcr) saved('ocrToken',W409.savedOcr)
  vi.stubEnv('NUXT_API_TOKEN',W409.envApi); vi.stubEnv('NUXT_MCP_TOKEN',W409.envMcp)
  vi.stubEnv('MIIT_COOKIE',' ' + W409.envCookie + ' '); vi.stubEnv('NUXT_OCR_TOKEN',partition.envOcr)
  vi.stubEnv('PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN',' ' + W409.paddle + ' ')
  const before = workerBusinessDigest409()
  const { message,progress,temporaryPath } = await actualWorker409(partition.mode,{ apiToken: W409.runtimeApi, mcpToken: W409.runtimeMcp, ocrToken: partition.runtimeOcr },'B3-' + partition.id)
  expect(message.type).toBe('done')
  if (message.type !== 'done') throw new Error('Expected actual workbook completion')
  expect(message.result.statusCounts).toEqual({effective:1,expired:0,terminated:0,moved_out:0,unrecognized:2})
  expect(message.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 2 }); expect(message.result.total).toBe(3)
  expect(progress).toContainEqual(expect.objectContaining({ done: 0, total: 3, snapshotId: 'actual-worker-409', ruleVersion: CURRENT_RULE_VERSION }))
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(temporaryPath)
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
  const selected = [W409.runtimeApi,W409.runtimeMcp,W409.envApi,W409.envMcp,partition.savedCookie ? W409.savedCookie : W409.envCookie,partition.selectedOcr]
  const expectedName = '合成公布 ' + Object.values(W409).map(value => selected.includes(value) ? '[REDACTED]' : value).join(' ') + ' 企业'
  const published = '2026年第1批认定，《B409合成公布.pdf》：公布名称：' + JSON.stringify(expectedName)
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).toBe(published)
  expect(workbook.getWorksheet('有效企业')!.getCell('L2').value).toContain('公布名称：' + JSON.stringify(expectedName))
  const cells: unknown[] = []
  for (const [sheetName,names] of [['有效企业',[W409_NAMES.eligible]],['未认定',[W409_NAMES.pending,W409_NAMES.excluded]],['已到期',[]],['已注销（吊销）',[]],['已迁出',[]]] as const) {
    const sheet = workbook.getWorksheet(sheetName)!
    expect(sheet.rowCount).toBe(names.length + 1)
    expect(sheet.getRow(1).values).toEqual([undefined,...HEADERS_409,'有效状态','有效期及排除依据','资料缺口与来源备注'])
    expect(Array.from({length:names.length},(_,i)=>sheet.getCell('B' + (i+2)).value)).toEqual(names)
    for (let row = 2; row <= sheet.rowCount; row++) {
      expect(sheet.getRow(row).cellCount).toBe(15)
      for (let c = 1; c <= 15; c++) cells.push(sheet.getRow(row).getCell(c).value)
    }
  }
  expect(workbook.getWorksheet('有效企业')!.getCell('G2').value).toBe('2026年第1批认定')
  expect(workbook.getWorksheet('未认定')!.getCell('G2').value).toBe('2022年第1批原认定批次，结论年份待核复核结论待核')
  expect(workbook.getWorksheet('未认定')!.getCell('G3').value).toBe('2022年第1批原认定批次，2025年复核未通过')
  expect(workbook.getWorksheet('未认定')!.getCell('K2').value).toContain('缺少已确认认定及资格依据')
  expect(workbook.getWorksheet('未认定')!.getCell('K3').value).toContain('缺少已确认认定及资格依据')
  expect(workbook.getWorksheet('未认定')!.getCell('O2').value).toContain('认定或复核周期资料不完整')
  expect(workbook.getWorksheet('未认定')!.getCell('M2').value).toBe('未认定')
  expect(workbook.getWorksheet('未认定')!.getCell('M3').value).toBe('未认定')
  for (const token of selected) expect(JSON.stringify(cells)).not.toContain(token)
  for (const token of Object.values(W409).filter(value => !selected.includes(value))) expect(String(workbook.getWorksheet('有效企业')!.getCell('H2').value)).toContain(token)
  expect(workerBusinessDigest409()).toBe(before)
},30000)

const invalidWorkerContexts409 = [
  { id: 'null', value: null }, { id: 'array', value: [] },
  { id: 'unknown', value: { extra: W409.runtimeApi } }, { id: 'wrongtype', value: { apiToken: 409 } },
  { id: 'utf8_field', value: { apiToken: '中'.repeat(5462) } },
  { id: 'ascii_field', value: { apiToken: 'z'.repeat(16385) } },
  { id: 'json_total', value: { apiToken: '\u0000'.repeat(16384) } },
]
it.each(workerModes409.flatMap(mode => invalidWorkerContexts409.map(input => ({ mode, ...input }))))('B4 actual worker $mode invalid IPC $id safe failure', async ({ mode,id,value }) => {
  const result = await actualWorker409(mode,value,'B4-invalid-' + id)
  expect(result.message).toEqual({ type: 'failure', message: W409_SAFE_FAILURE })
  expect(result.progress).toEqual([])
  expect(existsSync(result.temporaryPath)).toBe(false)
  expect(JSON.stringify(result.message)).not.toContain(root)
  for (const token of Object.values(W409)) expect(JSON.stringify(result.message)).not.toContain(token)
},30000)

it.each(workerModes409)('B4 actual worker %s credential storage fault never publishes incomplete workbook', async mode => {
  legalWorkerSeed409()
  db.$client.exec('drop table service_credential')
  const before = workerBusinessDigest409()
  const result = await actualWorker409(mode,{ apiToken: W409.runtimeApi, mcpToken: W409.runtimeMcp, ocrToken: W409.runtimeOcr },'B4-storage')
  expect(result.message).toEqual({ type: 'failure', message: W409_SAFE_FAILURE })
  expect(JSON.stringify(result.message)).not.toContain(root)
  for (const token of Object.values(W409)) expect(JSON.stringify(result.message)).not.toContain(token)
  // A worker has no publish capability. Its private output may exist after an error;
  // the job supervisor owns unlink. Never mistake that private prefix for an artifact.
  if (existsSync(result.temporaryPath)) {
    const workbook = new ExcelJS.Workbook()
    await expect(workbook.xlsx.readFile(result.temporaryPath)).rejects.toThrow()
  }
  expect(workerBusinessDigest409()).toBe(before)
},30000)
