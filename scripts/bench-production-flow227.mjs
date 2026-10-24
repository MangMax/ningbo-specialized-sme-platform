#!/usr/bin/env node
// Private fixed-request compiled Nitro benchmark; never accepts a remote base URL.
// node scripts/bench-production-flow227.mjs MATRIX SNAPSHOT ENTRY SOURCE_SHA NEW_RESULT_DIR
// Optional PERF227_CELL selects one cell for a smoke test; hot samples remain >=20.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, lstatSync, readlinkSync, rmSync, chmodSync, realpathSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, cpus, totalmem, loadavg, freemem } from 'node:os'
import { createConnection } from 'node:net'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const [matrixPath, snapshotText, entryText, sourceSha, outputText] = process.argv.slice(2)
const snapshot = realpathSync(snapshotText), entry = realpathSync(entryText), output = resolve(outputText)
assert.match(sourceSha, /^[a-f0-9]{40}$/)
assert.ok(!existsSync(output), 'never overwrite evidence')
assert.ok(snapshot !== entry && !output.startsWith(dirname(entry) + '/'), 'private scratch output outside artifact')
mkdirSync(output, { recursive: true, mode: 0o700 })
const matrixBytes = readFileSync(matrixPath), matrix = JSON.parse(matrixBytes)
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex')
async function fileHash(path) { const digest = createHash('sha256'); for await (const block of createReadStream(path)) digest.update(block); return digest.digest('hex') }
async function artifactManifest(root) {
  const files = []
  async function visit(path) { for (const name of readdirSync(path).sort()) {
    const p = join(path, name), st = lstatSync(p), rel = relative(root, p)
    if (st.isSymbolicLink()) files.push({ path: rel, symlink: readlinkSync(p) })
    else if (st.isDirectory()) await visit(p)
    else if (st.isFile()) files.push({ path: rel, bytes: st.size, sha256: await fileHash(p) })
  } }
  await visit(root); return { sha256: hash(files), files }
}
const artifact = await artifactManifest(dirname(entry))
const frozen = { sourceSha, sourceAssociation: 'caller-supplied build provenance; whole artifact hashed, no rebuild', node: process.version, matrixSha256: hash(matrixBytes), snapshotSha256: await fileHash(snapshot), artifact }
writeFileSync(join(output, 'manifest.json'), JSON.stringify(frozen, null, 2), { mode: 0o600 })
writeFileSync(join(output, 'matrix.json'), matrixBytes, { mode: 0o600 })
const resource = () => ({ at: new Date().toISOString(), hostname: hostname(), cpu: cpus()[0].model, cpus: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), loadavg: loadavg(), ps: execFileSync('ps', ['-Ao', 'pid,ppid,pcpu,rss,comm'], { encoding: 'utf8' }) })
writeFileSync(join(output, 'host-before.json'), JSON.stringify(resource(), null, 2), { mode: 0o600 })
const preload = fileURLToPath(new URL('./lib/perf227-preload.mjs', import.meta.url))
const requestAllowlist = [
  /^\/api\/roster\/record-comparison(?:\/sources)?$/,
  /^\/api\/roster\/enterprises(?:\/\d+)?$/,
  /^\/api\/roster\/events\/\d+$/,
  /^\/api\/platform\/queries\/\d+\/evidence$/,
  /^\/api\/roster\/correspondences(?:\/(?:discover|candidates|\d+(?:\/audit)?|events\/\d+|relations\/\d+|export-rows\/\d+))?$/,
  /^\/api\/task-center(?:\/[A-Z0-9]{26})?$/,
]
const allowedTools = new Set(['discover_event_archive_candidates', 'list_enterprises', 'get_enterprise_detail', 'get_official_event', 'get_record_correspondence_source', 'list_record_correspondences', 'get_record_correspondence', 'get_record_correspondence_audit', 'list_record_comparison', 'get_platform_query_evidence'])
const allResults = [], samplesFile = join(output, 'samples.ndjson')
let rpcId = 0
const facts = body => ({ total: body?.total, page: body?.page, pageSize: body?.pageSize, rows: body?.rows?.length, counts: body?.counts, coverage: body?.coverage ? { total: body.coverage.total, rows: body.coverage.rows?.length, outcomes: body.coverage.rows?.map(r => [r.interface, r.status, r.outcome, r.candidateCount, r.relationCount]) } : undefined, interfaces: body?.interfaces, ruleVersion: body?.ruleVersion })
function validCell(cell) {
  assert.ok(/^[a-z0-9_-]+$/.test(cell.name) && requestAllowlist.some(r => r.test(cell.path)), 'endpoint outside read whitelist')
  assert.ok((cell.method === 'POST' && /\/(discover|candidates)$/.test(cell.path)) || cell.method === 'GET', 'no write endpoint')
  assert.ok(!cell.tool || allowedTools.has(cell.tool), 'MCP tool outside whitelist')
  assert.ok(!cell.path.startsWith('/api/task-center') || cell.mutable, 'task initialization needs disposable RW lane')
}
for (const cell of matrix.cells) validCell(cell)
async function listener(server, port, attempts) {
  for (let i = 0; i < 200; i++) {
    assert.ok(server.exitCode === null && server.signalCode === null, 'owned server exited during startup')
    const result = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(250)
      socket.once('connect', () => { socket.destroy(); resolve(null) })
      socket.once('error', e => { socket.destroy(); resolve(e.code) })
      socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT') })
    })
    attempts.push({ i, error: result }); if (!result) return
    await sleep(100)
  }
  throw Error('owned server listener timeout')
}
async function run(cell, concurrency) {
  const label = `${cell.name}-c${concurrency}`, dir = join(output, label); mkdirSync(dir, { mode: 0o700 })
  const dbPath = join(dir, 'copy.db')
  // APFS clone is copy-on-write. No business SQL for setup or rollback.
  execFileSync('/bin/cp', ['-c', snapshot, dbPath]); chmodSync(dbPath, cell.mutable ? 0o600 : 0o400)
  const port = await reserveLoopbackPort(); assert.notEqual(port, 43932)
  const base = `http://127.0.0.1:${port}`, telemetry = join(dir, 'native.ndjson')
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LANG: 'en_US.UTF-8', NODE_OPTIONS: `--import=${preload}`, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: cell.mutable ? '0' : '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_API_TOKEN: 'synthetic-perf227-only', NUXT_MCP_TOKEN: 'synthetic-perf227-only', NUXT_MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', PERF227_ENTRY: entry, PERF227_TELEMETRY: telemetry }
  mkdirSync(env.NUXT_FILES_DIR)
  const startup = performance.now(), server = fork(entry, [], { cwd: dir, env, execArgv: ['--max-old-space-size=2048'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => appendFileSync(join(dir, 'server.log'), chunk, { mode: 0o600 }))
  let commandId = 0
  const phase = (action, phaseLabel) => new Promise((resolve, reject) => {
    const id = ++commandId
    const clean = () => { clearTimeout(timer); server.off('message', onMessage); server.off('exit', onExit) }
    const onExit = () => { clean(); reject(Error('owned server exited during phase')) }
    const onMessage = m => { if (m?.type !== 'perf227-phase' || m.id !== id) return; clean(); m.error ? reject(Error(m.error)) : resolve(m.result) }
    const timer = setTimeout(() => { clean(); reject(Error('telemetry timeout')) }, 15000)
    server.on('message', onMessage); server.once('exit', onExit)
    server.send({ type: 'perf227-phase', id, action, label: phaseLabel })
  })
  const result = { cell: cell.name, concurrency, sourceSha, mutable: !!cell.mutable, requestSha256: hash(cell), ambientBefore: { loadavg: loadavg(), freeMemory: freemem() }, attempts: [], errors: [] }
  const request = async (transport, sampleLabel) => {
    const started = performance.now(), at = Date.now()
    let sample
    try {
      const post = cell.method === 'POST', query = new URLSearchParams(Object.entries(cell.args).map(([k, v]) => [k, String(v)]))
      const response = await fetch(transport === 'rest' ? base + cell.path + (post ? '' : '?' + query) : base + '/mcp', {
        signal: AbortSignal.timeout(120000),
        ...(transport === 'mcp' ? { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: cell.tool, arguments: cell.mcpArgs } }) }
          : post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cell.args) } : {}),
      })
      const raw = await response.text(), ms = performance.now() - started
      let body = JSON.parse(raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? raw)
      let applicationError = false
      if (transport === 'mcp') {
        applicationError = !!(body.error || body.result?.isError)
        if (body.result?.content?.[0]?.text) {
          const content = body.result.content[0].text
          try { body = JSON.parse(content) }
          catch { body = { mcpText: content }; applicationError = true }
        }
      }
      sample = { at, label: sampleLabel, transport, status: response.status, ms, responseBytes: Buffer.byteLength(raw), canonicalSha256: hash(body), factsSha256: hash(facts(body)), facts: facts(body), error: response.status !== cell.expectedStatus || applicationError ? 'http-or-application-error' : null, cacheControl: response.headers.get('cache-control') }
      if (cell.expectedChunkSha256) {
        const bytes = Buffer.from(body.data ?? '', 'base64')
        sample.chunkSha256 = hash(bytes); sample.chunkBytes = bytes.length
        sample.totalBytes = body.totalBytes; sample.hasMore = body.hasMore
        if (sample.chunkSha256 !== cell.expectedChunkSha256 || bytes.length !== body.byteLength) sample.error = 'original-chunk-differs-from-snapshot'
      }
    } catch (error) { sample = { at, label: sampleLabel, transport, ms: performance.now() - started, error: String(error) } }
    appendFileSync(samplesFile, JSON.stringify({ cell: cell.name, concurrency, ...sample }) + '\n', { mode: 0o600 })
    if (sample.error) result.errors.push(sample)
    return sample
  }
  try {
    await listener(server, port, result.attempts)
    result.listenerReadyMs = performance.now() - startup
    result.coldLabel = 'first selected business request in fresh compiled process; TCP readiness only; no HTTP prewarm; OS cache not purged'
    await phase('begin', 'first')
    result.first = await request('rest', 'fresh-process')
    result.firstTelemetry = await phase('end', 'first')
    if (cell.tool) {
      result.parity = await request('mcp', 'parity-excluded-from-hot')
      result.parityEqual = !result.parity.error && result.parity.canonicalSha256 === result.first.canonicalSha256
    }
    // One explicit REST warmup; keep its failure, never retry a measurement.
    result.warmup = await request('rest', 'warmup-excluded-from-hot')
    await phase('begin', 'hot')
    const start = performance.now(), hot = []
    for (let i = 0; i < 20; i += concurrency) hot.push(...await Promise.all(Array.from({ length: Math.min(concurrency, 20 - i) }, (_, k) => request('rest', `hot-${i + k}`))))
    result.hotElapsedMs = performance.now() - start
    result.hotTelemetry = await phase('end', 'hot')
    const times = hot.map(s => s.ms).sort((a, b) => a - b), p = n => times[Math.ceil(times.length * n) - 1]
    result.hot = { samples: hot.length, p50: p(.5), p95: p(.95), p99: p(.99), errors: hot.filter(s => s.error).length, errorRate: hot.filter(s => s.error).length / hot.length, responseBytes: [...new Set(hot.map(s => s.responseBytes))], hashes: [...new Set(hot.map(s => s.canonicalSha256))] }
    result.stable = !result.first.error && hot.every(s => !s.error && s.canonicalSha256 === result.first.canonicalSha256) && result.warmup.canonicalSha256 === result.first.canonicalSha256
  } catch (error) { result.errors.push({ phase: 'control', error: String(error) }) }
  finally {
    await stopOwnedChild(server)
    // Child native process exits on IPC disconnect; retain its diagnostics.
    await sleep(50)
    result.dbAfterSha256 = await fileHash(dbPath)
    result.dbMainFileUnchanged = result.dbAfterSha256 === frozen.snapshotSha256
    result.walAfterBytes = existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').size : 0
    result.walAfterSha256 = result.walAfterBytes ? await fileHash(dbPath + '-wal') : null
    result.dbUnchanged = result.dbMainFileUnchanged && result.walAfterBytes === 0
    if (!cell.mutable && !result.dbUnchanged) result.errors.push({ error: 'readonly clone changed' })
    result.ambientAfter = { loadavg: loadavg(), freeMemory: freemem() }
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  }
  return result
}
// Exactly one controlled lane at a time; concurrency only inside that lane.
for (const cell of matrix.cells.filter(c => !process.env.PERF227_CELL || c.name === process.env.PERF227_CELL)) for (const concurrency of [1, 2, 5]) {
  const result = await run(cell, concurrency); allResults.push(result)
  appendFileSync(join(output, 'results.ndjson'), JSON.stringify(result) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ cell: cell.name, concurrency, firstMs: result.first?.ms, p95: result.hot?.p95, stable: result.stable, parity: result.parityEqual, errors: result.errors.length }))
}
assert.ok(allResults.length, 'no matching matrix cells')
const immutableAfter = await fileHash(snapshot), artifactAfter = await artifactManifest(dirname(entry))
writeFileSync(join(output, 'host-after.json'), JSON.stringify(resource(), null, 2), { mode: 0o600 })
const final = { sourceSha, cells: allResults.length, errors: allResults.reduce((n, r) => n + r.errors.length, 0), unstable: allResults.filter(r => !r.stable).length, parityFailures: allResults.filter(r => r.parityEqual === false).length, immutableUnchanged: immutableAfter === frozen.snapshotSha256, artifactUnchanged: artifactAfter.sha256 === artifact.sha256 }
writeFileSync(join(output, 'summary.json'), JSON.stringify(final, null, 2), { mode: 0o600 }); console.log(JSON.stringify(final))
if (final.errors || final.unstable || final.parityFailures || !final.immutableUnchanged || !final.artifactUnchanged) process.exitCode = 1
