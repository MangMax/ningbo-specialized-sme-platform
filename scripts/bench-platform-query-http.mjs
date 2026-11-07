#!/usr/bin/env node
// Production artifact, real HTTP/MCP, synthetic read-only SQLite. Does not build or contact production.
// Historical controlled runs require PERF_EXPECTED_ARTIFACT_MANIFEST and PERF_BENCHMARK_SOURCE_SHA.
// Current: PERF_BENCHMARK_LANE=current-read plus explicit PERF_CURRENT_{ARTIFACT,ENVELOPE,
// WORKLOAD,FIXTURE,DELIVERY,OUTPUT}. Only the parent-accepted #621 local delivery is frozen.
// Existing telemetry resolves this checkout's .output: it must reference that same output.
// PERF_POSTVALIDATION=1 is a separate driver-scheduling diagnostic, never replacement acceptance.
// node scripts/bench-platform-query-http.mjs /absolute/synthetic.sqlite <http|mcp> <full|summary|interface|title|key|chunk> [concurrency=1]
import assert from 'node:assert/strict'

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { performanceController } from './lib/performance-controller.mjs'
import { compareCurrentReadAuthority, readSqliteNativeIdentity, readBenchmarkAuthority } from './lib/benchmark-authority.mjs'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, getOwnedChildStartFailure } from './lib/isolated-local-services.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value))
const equal = (actual, expected, label) => assert.deepEqual(actual, expected, `REJECTED current-read: ${label}`)
const need = (ok, label) => assert.ok(ok, `REJECTED current-read: ${label}`)

// This is an explicitly frozen local delivery, not a general receipt authenticator.
// Parent-accepted provenance is pinned independently of benchmark observations.
const pins = {
 fixture: 'b5928c2e17e139054de92b01006af5ae383ad63664a6211cf0f9eeb4039c2978',
 artifact: '6c47126bb02235ca79d39e1bb1a9714ee693726629056c61fb158dd67dc429d2',
 envelope: '3d6885ba6c8710fa98cf190a1d44fa827e8f0624a3bcaed71a16481bac637cea',
 acceptance: '6f7fd67d8669a317e7da0cefe831d73e635124f0fd4452c938ff06649cca9e4b',
 mapping: '4ffcff88ae27aa4fd73f07aa14b281c28196b2b4700b4b77c20491f83f421916',
 http: '83945f8cbc141f05e1efc2a09c18b295326e0b240304b8131215d346f7a0b6b8',
 mcp: 'd71ef8633165e44941b53af6c70750ac9dfbc3bf3c71c9f1eee72302b9527a64',
}
export function currentOptions(o) {
 need(o.concurrency === 1 && o.samples === 20 && !o.postvalidation, 'only concurrency=1 samples=20 inline is frozen')
 for (const key of ['artifactPath', 'envelopePath', 'workloadPath', 'fixturePath', 'deliveryDir', 'outputDir']) need(typeof o[key] === 'string' && o[key].startsWith('/'), `explicit ${key} required`)
 return o
}
export function currentRequest(scenario, id) {
 const r = structuredClone(scenario.request)
 if (scenario.transport === 'mcp') r.id = id
 return r
}
export function validateCurrentResponse(s, sent, response, id) {
 equal(sent, currentRequest(s, id), 'request path/query/tool/arguments')
 equal(response.status, 200, 'status')
 equal(response.redirected, false, 'response redirect')
 const url = new URL(response.url)
 equal(url.pathname, sent.path, 'response path')
 equal([...url.searchParams].sort(), s.transport === 'http' ? Object.entries(sent.query).sort() : [], 'response query')
 let body
 if (response.text.trimStart().startsWith('{')) body = JSON.parse(response.text)
 else {
  const events = response.text.replaceAll('\r\n', '\n').split('\n\n').map(event => event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')).filter(Boolean)
  equal(events.length, 1, 'rpc envelope count'); body = JSON.parse(events[0])
 }
 let result = body
 if (s.transport === 'mcp') {
  equal(body.jsonrpc, '2.0', 'rpc.jsonrpc'); equal(body.id, id, 'rpc.id')
  need(!Object.hasOwn(body, 'error'), 'rpc.error')
  need(body.result && (!Object.hasOwn(body.result, 'isError') || body.result.isError === false), 'rpc.isError')
  equal(body.result.content?.length, 1, 'rpc.content length')
  equal(body.result.content[0].type, 'text', 'rpc.content type')
  result = JSON.parse(body.result.content[0].text)
 }
 const expected = s.expected
 if (s.mode === 'chunk') {
  for (const key of Object.keys(expected).filter(k => k !== 'decodedHex')) equal(result[key], expected[key], `chunk.${key}`)
  equal(Buffer.from(result.data, 'base64').toString('hex'), expected.decodedHex, 'chunk.decoded bytes')
  equal(Buffer.from(result.data, 'base64').length, result.byteLength, 'chunk.decoded length')
 } else {
  for (const key of ['total', 'page', 'pageSize', 'counts']) equal(result[key], expected[key], key)
  equal(result.rows?.length, expected.rows.length, 'rows.length')
  expected.rows.forEach((row, i) => {
   const actual = result.rows[i].query
   need(actual && typeof actual === 'object', `rows[${i}].query`)
   for (const key of ['id', 'queryKey', 'status', 'relationCount']) equal(actual[key], row[key], `rows[${i}].${key}`)
   need(Array.isArray(result.rows[i].relations), `rows[${i}].relations`)
   equal(result.rows[i].relations.map(r => r.id), row.relationIds, `rows[${i}].relationIds`)
   if (row.omittedQueryFields) {
    equal(result.rows[i].relationsIncluded, false, `rows[${i}].relationsIncluded`)
    for (const key of row.omittedQueryFields) need(!Object.hasOwn(actual, key), `rows[${i}].omitted ${key}`)
   } else equal(actual.collectionEvidence, row.collectionEvidence, `rows[${i}].collectionEvidence`)
   if (Object.hasOwn(row, 'rawHex')) {
    equal(actual.rawResponse, row.rawResponse, `rows[${i}].rawResponse`)
    equal(Buffer.from(actual.rawResponse).toString('hex'), row.rawHex, `rows[${i}].rawHex`)
   }
  })
 }
 return digest(result) // Auxiliary only; the independent projection above is the oracle.
}
function readPinned(path, hash, label) {
 const bytes = readFileSync(path); equal(sha(bytes), hash, `${label} document bytes`)
 return JSON.parse(bytes)
}
export function verifyCurrentInputs(o, dbPath, transport, mode) {
 try { return collectCurrentInputs(o, dbPath, transport, mode) }
 catch(error) { throw new Error(`REJECTED current-read inputs: ${error.message}`, { cause: error }) }
}
function collectCurrentInputs(o, dbPath, transport, mode) {
 currentOptions(o)
 const fixture = readPinned(o.fixturePath, pins.fixture, 'fixture')
 const artifact = readPinned(o.artifactPath, pins.artifact, 'artifact')
 const envelope = readPinned(o.envelopePath, pins.envelope, 'envelope')
 const workload = readPinned(o.workloadPath, pins[transport], 'workload')
 const acceptance = readPinned(join(o.deliveryDir, 'parent-acceptance.json'), pins.acceptance, 'parent acceptance')
 const mapping = readPinned(join(o.deliveryDir, 'schema-input-mapping.json'), pins.mapping, 'mapping')
 equal(acceptance.artifactManifestSha256, pins.artifact, 'parent artifact binding')
 for (const key of ['lane','schemaVersion','receiptId','manifestSha256','identity','runtime']) equal(envelope[key], mapping[key], `621 envelope/delivery mapping ${key}`)
 equal(envelope.identity, artifact.identity, 'artifact identity mapping'); equal(envelope.runtime, artifact.runtime, 'artifact runtime mapping')
 equal(fixture.artifactManifestSha256, pins.artifact, 'fixture artifact binding')
 equal(workload.manifestSha256, pins.fixture, 'workload fixture binding')
 equal(digest(fixture.seed), workload.seedManifestSha256, 'seed mapping')
 equal(digest(fixture.scenarios.map(s => s.request)), workload.parametersSha256, 'parameters mapping')
 equal(digest(fixture.scenarios.map(s => s.expected)), workload.semanticExpectedSha256, 'expected mapping')
 equal(workload.scenarios, fixture.scenarios.filter(s => s.transport === transport).map(s => ({ id: s.id, mode: s.mode, requestSha256: digest(s.request), expectedSha256: digest(s.expected) })), 'scenario mappings')
 const identity = artifact.identity
 const document = (name, hash) => readPinned(join(o.deliveryDir, name), hash, name)
 document('receipt.json', identity.buildReceiptSha256)
 const inventory = document('artifact-inventory.json', identity.outputManifestSha256)
 const dependencies = document('dependency-inventory.json', identity.dependencyManifestSha256)
 // Walk actual complete output, including directories/symlinks; no omitted chunks or dependencies.
 const paths = []
 function walk(dir, prefix = '') { for (const name of readdirSync(dir).sort()) {
  const relative = prefix + name, path = join(dir, name); paths.push(relative)
  if (lstatSync(path).isDirectory()) walk(path, relative + '/')
 } }
 walk(o.outputDir); equal(paths.sort(), inventory.files.map(f => f.path).sort(), 'complete output paths')
 for (const f of inventory.files) {
  const path = join(o.outputDir, f.path), stat = lstatSync(path)
  equal(stat.mode & 0o7777, parseInt(f.mode, 8), `output mode ${f.path}`)
  equal(stat.size, f.size, `output size ${f.path}`)
  equal(stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', f.type, `output type ${f.path}`)
  if (f.type !== 'directory') equal(sha(f.type === 'symlink' ? readlinkSync(path) : readFileSync(path)), f.sha256, `output bytes ${f.path}`)
  if (f.type === 'symlink') {
   need(realpathSync(path).startsWith(realpathSync(o.outputDir) + '/'), 'dependency symlink containment')
   if (f.resolvedContentSha256) equal(sha(readFileSync(path)), f.resolvedContentSha256, 'resolved dependency bytes')
  }
 }
 equal(dependencies.files, inventory.files.filter(f => f.path.startsWith('server/node_modules/')), 'full dependency closure')
 equal(identity.files, inventory.files.filter(f => f.type !== 'directory').map(f => ({ path: f.path, sha256: f.sha256 })), 'output identity mapping')
 const migrations = join(o.deliveryDir, 'migrations')
 const journal = readPinned(join(migrations, 'meta/_journal.json'), identity.journalSha256, 'journal').entries
 equal(journal.length, 44, 'journal length')
 equal(journal.map(e => ({ tag: e.tag, when: e.when, sqlSha256: sha(readFileSync(join(migrations, e.tag + '.sql'))) })), identity.journal, '44 SQL closure')
 equal(readdirSync(migrations).filter(f => f.endsWith('.sql')).sort(), journal.map(e => e.tag + '.sql').sort(), 'no extra SQL')
 equal(realpathSync(new URL('../.output/server/index.mjs', import.meta.url)), realpathSync(join(o.outputDir, 'server/index.mjs')), 'telemetry uses same compiled output')
 const require = createRequire(join(o.outputDir, 'server/index.mjs'))
 const native = readSqliteNativeIdentity(require)
 const runtime = { nodeVersion: process.version, platform: process.platform, arch: process.arch, nativeSha256: native.nativeSha256 }
 equal(runtime, artifact.runtime, 'actual Node/OS/arch/native')
 const Database = require('better-sqlite3')
 const verifyDb = () => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
   const quote = name => '"' + name.replaceAll('"', '""') + '"'
   const names = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map(r => r.name)
   equal(names, fixture.tables, '63 table names')
   const logical = names.map(name => {
    const cols = db.prepare(`pragma table_info(${quote(name)})`).all().map(c => c.name).sort()
    const rows = db.prepare(`select ${cols.map(quote)} from ${quote(name)}`).all().map(r => cols.map(c => r[c])).sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
    return [name, cols, rows]
   })
   equal(digest(logical), workload.fixtureSha256, 'actual logical full DB')
   const ledger = db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all()
   equal(ledger, identity.journal.map(e => ({ hash: e.sqlSha256, created_at: e.when })), 'all ledger rows')
   equal(digest(ledger), workload.ledgerReceiptSha256, 'ledger mapping')
   return { logicalSha256: digest(logical), ledgerSha256: digest(ledger), physicalSha256: sha(readFileSync(dbPath)) }
  } finally { db.close() }
 }
 const before = verifyDb()
 const comparison = compareCurrentReadAuthority(envelope, workload, { lane: 'current-read', schemaVersion: 1, artifact: structuredClone(envelope), workload: structuredClone(workload) })
 return { artifactAuthority: { comparison, sourceSha: identity.sourceSha, manifestSha256: pins.artifact, fixtureSha256: pins.fixture, before },
  scenario: fixture.scenarios.find(s => s.transport === transport && s.mode === mode), migrations,
  verifyAfter: () => { equal(verifyDb(), before, 'DB logical/ledger/physical unchanged'); return before }, runtime }
}

// A single real abort covers both headers and body; health bodies are consumed too.
async function readResponse(url, options={}, timeoutMs=2000) {
 const abort=new AbortController()
 const timer=setTimeout(()=>abort.abort(new Error('HTTP headers/body deadline exceeded')),timeoutMs)
 try {
  const response=await fetch(url,{...options,signal:abort.signal})
  const text=await response.text()
  return {response,text}
 } finally {clearTimeout(timer)}
}

export async function main() {
const [dbPath,transport='http',mode='summary',concurrencyText='1']=process.argv.slice(2)
const concurrency=Number(concurrencyText)
assert.ok(dbPath?.startsWith('/') && ['http','mcp'].includes(transport) && ['full','summary','interface','title','key','chunk'].includes(mode) && [1,2,5].includes(concurrency))
const lane=process.env.PERF_BENCHMARK_LANE ?? 'legacy'
need(['legacy','current-read'].includes(lane), 'unknown lane')
const current=lane==='current-read'?verifyCurrentInputs({ concurrency, samples:Number(process.env.PERF_SAMPLES ?? 20), postvalidation:process.env.PERF_POSTVALIDATION==='1', artifactPath:process.env.PERF_CURRENT_ARTIFACT, envelopePath:process.env.PERF_CURRENT_ENVELOPE, workloadPath:process.env.PERF_CURRENT_WORKLOAD, fixturePath:process.env.PERF_CURRENT_FIXTURE, deliveryDir:process.env.PERF_CURRENT_DELIVERY, outputDir:process.env.PERF_CURRENT_OUTPUT },dbPath,transport,mode):null
const artifactAuthority=current?.artifactAuthority ?? readBenchmarkAuthority(process.env.PERF_BENCHMARK_SOURCE_SHA)
let dir, server, phases, receipt, primaryError, childError
const cleanupErrors=[]
let base, forkAttempted=false, startFailure
const childErrors=[]
const onChildError=error=>{childError=error;childErrors.push(error)}
let output=''
function observeChild() {
 server.on('error',onChildError)
 for(const stream of new Set(server.stdio ?? [])) {
  if(stream && typeof stream.on==='function') {
   stream.on('error',onChildError)
   if(typeof stream.resume==='function')stream.on('data',b=>{output=(output+b).slice(-2000)})
  }
 }
}
try {
dir=mkdtempSync(join(tmpdir(),'platform-read-telemetry-'))
const telemetry=join(dir,'telemetry.mjs')
writeFileSync(telemetry, `import ${JSON.stringify(new URL('./lib/performance-preload.mjs', import.meta.url).href)};` + (current ? `
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {readSqliteNativeIdentity} from ${JSON.stringify(new URL('./lib/benchmark-authority.mjs',import.meta.url).href)};
const native=readSqliteNativeIdentity(createRequire(${JSON.stringify(join(process.env.PERF_CURRENT_OUTPUT,'server/index.mjs'))}));
writeFileSync(${JSON.stringify(join(dir,'runtime-identity.json'))}, JSON.stringify({nodeVersion:process.version,platform:process.platform,arch:process.arch,nativeSha256:native.nativeSha256}));
` : ''))
if(current){mkdirSync(join(dir,'db'));symlinkSync(current.migrations,join(dir,'db/migrations'))}
const port=await reserveLoopbackPort()
base=`http://127.0.0.1:${port}`
forkAttempted=true
try {
server=fork(current?join(process.env.PERF_CURRENT_OUTPUT,'server/index.mjs'):'.output/server/index.mjs',[],{...(current?{cwd:dir}:{}),execArgv:['--max-old-space-size=2048','--import',telemetry],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_DB_READONLY:'1',NUXT_FILES_DIR:dir,MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe','ipc']})
} catch(error) {
 startFailure=getOwnedChildStartFailure(error)
 if(startFailure){server=startFailure.child;observeChild()}
 throw error
}
observeChild()
phases=performanceController(server)
let id=0
function validate(text, sent, status=200, requestId=id, response) {
 if(current)return phases.driver.measure('currentSemanticValidation',()=>validateCurrentResponse(current.scenario,sent,{status,text,url:response.url,redirected:response.redirected},requestId))
 const body=phases.driver.measure('decode',()=>JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??text))
 const result=transport==='http'?body:phases.driver.measure('decodeMcp',()=>JSON.parse(body.result.content[0].text))
 if(mode==='chunk')assert.equal(result.byteLength,65536)
 else {assert.equal(result.rows.length,mode==='key'?1:25);if(['summary','interface','title'].includes(mode))assert.equal(result.rows[0].relationsIncluded,false)}
 return phases.driver.measure('semanticHash',()=>createHash('sha256').update(JSON.stringify(result)).digest('hex'))
}
async function request(deferValidation=false) {
 const args=mode==='chunk'?{queryId:1000,field:'collectionEvidence',offset:0,length:65536}:{page:1,pageSize:25,...(['summary','interface','title'].includes(mode)?{view:'summary'}:{}),...(mode==='interface'?{interface:'recognized_list'}:{}),...(mode==='title'?{titleCode:'specialized_sme'}:{}),...(mode==='key'?{queryKey:'synthetic:1000',pageSize:1,includeRawResponse:true}:{})}
 const requestId=current?++id:undefined, sent=current?currentRequest(current.scenario,requestId):null
 const start=performance.now()
 if(current){
  const {response,text}=transport==='http'?await readResponse(`${base}${sent.path}?${new URLSearchParams(sent.query)}`):await readResponse(`${base}${sent.path}`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify(Object.fromEntries(Object.entries(sent).filter(([key])=>key!=='path')))})
  const ms=performance.now()-start
  return {ms,responseBytes:Buffer.byteLength(text),resultHash:validate(text,sent,response.status,requestId,response),scenarioId:current.scenario.id,requestId,requestSha256:digest(current.scenario.request),expectedSha256:digest(current.scenario.expected)}
 }
 const {response,text}=transport==='http'?await readResponse(`${base}${mode==='chunk'?'/api/platform/queries/1000/evidence':'/api/platform/queries'}?${new URLSearchParams(Object.entries(args).filter(([key])=>mode!=='chunk'||key!=='queryId').map(([k,v])=>[k,String(v)]))}`):await readResponse(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:mode==='chunk'?'get_platform_query_evidence':'list_platform_queries',arguments:args}})})
 const ms=performance.now()-start
 assert.equal(response.status,200)
 return {ms,responseBytes:Buffer.byteLength(text),...(deferValidation?{capturedBody:text}:{resultHash:validate(text)})}
}
 let ready=false, lastReadyError
 const readyDeadline=performance.now()+12_000
 while(performance.now()<readyDeadline){
  if(childError)throw childError
  if(server.exitCode!==null || server.signalCode!==null)throw Error(`Application exited before readiness: ${output}`)
  try{ready=(await readResponse(`${base}/api/health`,{},Math.min(2000,Math.max(1,readyDeadline-performance.now())))).response.ok}
  catch(error){lastReadyError=error}
  if(ready)break
  await sleep(Math.min(100,Math.max(0,readyDeadline-performance.now())))
 }
 if(!ready && lastReadyError)output+=` ${lastReadyError.message}`
 assert.ok(ready,`production artifact readiness: ${output}`)
 if(current)equal(JSON.parse(readFileSync(join(dir,'runtime-identity.json'))),current.runtime,'actual child loaded runtime identity')
 await phases.begin('cold')
 const cold=await request(),coldPhases=await phases.end('cold')
 await phases.begin('warmup');const warmup=await request(),warmupPhases=await phases.end('warmup')
 await phases.begin('hot');const hot=[],deferredValidation=process.env.PERF_POSTVALIDATION==='1'
 for(let round=0;round<20;round+=concurrency)hot.push(...await Promise.all(Array.from({length:concurrency},()=>request(deferredValidation))))
 const hotPhases=await phases.end('hot')
 let validationPhases
 if(deferredValidation){await phases.begin('postvalidation');for(const sample of hot){sample.resultHash=validate(sample.capturedBody);delete sample.capturedBody}validationPhases=await phases.end('postvalidation')}
 assert.ok(hot.every(sample=>sample.resultHash===cold.resultHash),'public result changed between cold and hot requests')
 const sorted=hot.map(x=>x.ms).sort((a,b)=>a-b), percentile=p=>sorted[Math.ceil(p*sorted.length)-1]
 receipt={artifactAuthority,...(current?{status:'SAMPLE_PROJECTION_VERIFIED',runtimeIdentity:current.runtime,serverPid:server.pid,runtimeDirectory:dir,base,scope:'621 small synthetic frozen projection only; unrelated DTO fields and original scale/SLO UNVALIDATED',lane}:{}),driverScheduling:current?'inline frozen projection validation; wall timing ends after full body read, before validation':deferredValidation?'postvalidation diagnostic; every full body validated after timing':'inline semantic validation; original shared quota workload',validationPhases,transport,mode,concurrency,dbPath,coldLabel:'fresh server process; OS cache not purged',cold,warmup,retainedSamples:hot,hotSamples:hot.length,hot:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)},responseBytes:hot[0].responseBytes,coldPhases,warmupPhases,hotPhases,peakHeap:hotPhases.app.peakHeap,peakRss:hotPhases.app.peakRss,osPeakRss:hotPhases.app.osPeakRss,heapLimit:hotPhases.app.heapLimit,eventLoopP95Ms:hotPhases.app.loopP95Ms,eventLoopMaxMs:hotPhases.app.loopMaxMs}
} catch(error) {primaryError=error}
finally {
 if(phases)try{phases.close()}catch(error){cleanupErrors.push(new Error('Controller close failed',{cause:error}))}
 let confirmed=!forkAttempted, stopState=forkAttempted?'unknown acquisition':'not-acquired'
 if(server) {
  try{await stopOwnedChild(server);confirmed=true;stopState='resolved'}
  catch(error){
   cleanupErrors.push(new Error('Public stop failed',{cause:error}))
   const result=error?.stopResult
   const known=result?.brand==='isolated-local-services.stop' && result.version===1
   confirmed=known && result.termination==='confirmed'
   stopState=known?JSON.stringify(result):'unknown stop receipt'
  }
 }
 // Read-only full logical/ledger/physical witness is attempted on failure as well.
 if(current)try{current.artifactAuthority.after=current.verifyAfter()}
 catch(error){cleanupErrors.push(new Error('DB verifyAfter failed',{cause:error}))}
 if(!confirmed) {
  cleanupErrors.push(new Error(`UNCONFIRMED owned service pid=${server?.pid ?? 'unknown'}; root retained at ${dir}; start=${startFailure?.reason ?? (forkAttempted?'unknown':'not-attempted')}; state=${stopState}`))
  // These release caller handles only; they are never evidence of service termination.
  if(server) {
   const releases=[
    ...[...new Set(server.stdio ?? [])].filter(stream=>stream && typeof stream.destroy==='function').map(stream=>()=>stream.destroy()),
    ()=>{if(server.connected)server.disconnect()},()=>server.unref(),
   ]
   for(const release of releases)try{release()}catch(error){cleanupErrors.push(new Error('Caller handle release failed',{cause:error}))}
  }
 }
 if(dir && confirmed)try{rmSync(dir,{recursive:true,force:true})}
 catch(error){cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${dir}`,{cause:error}))}
 // Release events can arrive asynchronously; retain listeners through that turn.
 await new Promise(resolve=>setImmediate(resolve))
 const asynchronous=[...new Set([...childErrors,...(startFailure?.errors ?? [])])]
 for(const error of asynchronous)cleanupErrors.push(new Error('Owned child asynchronous error',{cause:error}))
 if(startFailure?.droppedErrors)cleanupErrors.push(new Error(`Owned child droppedErrors=${startFailure.droppedErrors}`))
 if(server){
  server.off('error',onChildError)
  for(const stream of new Set(server.stdio ?? []))stream?.off?.('error',onChildError)
 }
}
if(primaryError || cleanupErrors.length)throw new AggregateError([
 ...(primaryError?[primaryError]:[]),...cleanupErrors,
],'Benchmark failed (primary/controller/stop/verifyAfter/root diagnostics retained)')
console.log(JSON.stringify(receipt))

}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main()
