import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'

const flags = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? true : arg.slice(i + 1)] }))
if (!flags.db || !flags.out || !flags.work) throw new Error('Required: --db=PRIVATE_DB --work=PRIVATE_DIR --out=OUTPUT_JSONL [--scenarios=...] [--concurrency=1,2,5] [--rounds=5] [--write]')
const work = realpathSync(flags.work)
const dbPath = realpathSync(flags.db)
if (!dbPath.startsWith(work + '/') || dbPath.includes('/production-docker/') || existsSync(flags.out)) throw new Error('Isolated DB and new output file required')
mkdirSync(resolve(work, 'runs'), { recursive: true, mode: 0o700 })
const db = new Database(dbPath, { readonly: true })
const selectorPath = flags.selectors ? (existsSync(flags.selectors) ? realpathSync(flags.selectors) : join(realpathSync(dirname(resolve(flags.selectors))), basename(flags.selectors))) : null
if (selectorPath && !selectorPath.startsWith(work + '/')) throw new Error('Selector file must be private')
let selectors
if (selectorPath && existsSync(selectorPath)) selectors = JSON.parse(readFileSync(selectorPath, 'utf8'))
else {
  const enterpriseId = db.prepare('select min(id) id from enterprise').get().id ?? 1
  const queryId = db.prepare('select id from platform_query order by length(raw_response) desc limit 1').get()?.id ?? 1
  selectors = { enterpriseId, queryId,
    eventId: db.prepare('select min(id) id from record_event').get().id ?? 1,
    relationId: db.prepare('select min(id) id from platform_relation').get().id ?? 1,
    docId: db.prepare("select min(id) id from source_document where source='jxj'").get().id ?? 1,
    exportId: db.prepare('select min(id) id from platform_export_batch').get().id ?? 1,
    fileBodyPath: db.prepare('select rel_path p from stored_file where removed_at is null order by bytes desc limit 1').get()?.p ?? 'missing.pdf',
    fileId: db.prepare('select file_id id from ocr_result group by file_id order by count(*) desc limit 1').get()?.id ?? 1,
    privateKey: db.prepare('select query_key k from platform_query where id=?').get(queryId)?.k ?? 'name:empty',
    title: db.prepare('select title_code t from record where enterprise_id=? limit 1').get(enterpriseId)?.t ?? 'specialized_sme',
  }
  if (selectorPath) writeFileSync(selectorPath, JSON.stringify(selectors), { mode: 0o600 })
}
const { enterpriseId, queryId, eventId, relationId, docId, exportId, fileBodyPath, fileId, privateKey, title } = selectors
const tableCounts = Object.fromEntries(db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(({ name }) => [name, db.prepare(`select count(*) n from "${name}"`).get().n]))
db.close()
const q = encodeURIComponent(privateKey)
const cases = {
  platform_page: { path: '/api/platform/queries?pageSize=25' },
  platform_deep: { path: '/api/platform/queries?page=1000&pageSize=25' },
  platform_key: { path: `/api/platform/queries?queryKey=${q}&pageSize=25` },
  platform_raw: { path: `/api/platform/queries?queryKey=${q}&includeRawResponse=true&pageSize=25` },
  enterprise_page: { path: '/api/roster/enterprises?pageSize=50' },
  enterprise_deep: { path: '/api/roster/enterprises?pageSize=50&page=100' },
  enterprise_id: { path: `/api/roster/enterprises/${enterpriseId}` },
  sources: { path: '/api/roster/record-comparison/sources?pageSize=50' },
  comparison_id: { path: `/api/roster/record-comparison?queryIds=${queryId}&exportBatchIds=&officialSourceDocumentIds=${docId}&enterpriseId=${enterpriseId}&pageSize=50` },
  correspondence_page: { path: '/api/roster/correspondences?pageSize=50' },
  event_id: { path: `/api/roster/correspondences/events/${eventId}` },
  relation_id: { path: `/api/roster/correspondences/relations/${relationId}` },
  candidates: { path: '/api/roster/correspondences/candidates', method: 'POST', body: { enterpriseId, titleCode: title, queryIds: [queryId], exportBatchIds: [], ruleVersion: 'perf82', pageSize: 50 } },
  records: { path: '/api/records?pageSize=25' }, stats: { path: '/api/stats' }, quality: { path: '/api/quality' },
  legacy_comparison: { path: '/api/comparison' }, recognitions: { path: '/api/roster/recognitions?pageSize=50' },
  differences: { path: '/api/roster/differences?pageSize=50' },
  export_roster: { path: '/api/roster/export' }, export_records: { path: '/api/export' },
  jobs: { path: '/api/jobs?pageSize=25' }, files: { path: '/api/files?pageSize=25' },
  ocr_metadata: { path: `/api/ocr-results?fileId=${fileId}` },
  ocr_markdown: { path: `/api/ocr-results/markdown?fileId=${fileId}` },
  full_task_plan: { path: '/__perf82/reconcile-targets' },
  ocr_storage_metadata: { path: `/__perf82/ocr-pages?fileId=${fileId}` },
  ocr_storage_markdown: { path: `/__perf82/ocr-pages?fileId=${fileId}&markdown=1` },
  snapshots: { path: '/api/platform/snapshots' },
  snapshot_diff: { path: `/api/platform/snapshots/diff?from=${exportId}&to=${exportId}` },
  proofs: { path: '/api/roster/comparison-scope-proofs?pageSize=50' },
  calibration_block: { path: '/__perf82/calibration-block' },
}
if (flags.files) cases.file_stream = { path: `/__perf82/file-by-path?path=${encodeURIComponent(fileBodyPath)}` }
function batch(n, id) {
  return { idempotencyKey: `perf82-${id}`, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/perf82',
    payload: { platformQueries: Array.from({ length: n }, (_, i) => ({ interface: 'business_list', queryKey: `name:perf82-${id}-${i}`, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19T00:00:00.000Z', status: 'no_record', rawResponse: 'synthetic no-record', relations: [] })) } }
}
for (const n of [1, 300, 1000]) for (const action of ['preflight', 'commit']) cases[`${action}_${n}`] = { path: `/api/roster/import/${action}`, method: 'POST', bodyFactory: id => batch(n, id), expectedQueries: n, action }
cases.mixed_read_write = { mixed: true }
const selected = flags.scenarios ? flags.scenarios.split(',') : Object.keys(cases).filter(k => !/^(commit|preflight|mixed|calibration)/.test(k))
const emit = value => appendFileSync(flags.out, JSON.stringify(value) + '\n', { mode: 0o600 })
emit({ type: 'environment', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  timestamp: new Date().toISOString(), node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  heapMiB: 2048, containerLimited: false, rounds: Number(flags.rounds ?? 5), diagnosticDeadlineMs: Number(flags.timeout ?? 90000), tableCounts,
  loadAverage: os.loadavg(),
  instrumentation: 'actual HTTP route modules on h3 loopback; SQL includes driver row materialization; residual is not pure aggregation; cold process != cold OS cache; sampled heap and process high-water RSS' })

for (const scenario of selected) for (const concurrency of String(flags.concurrency ?? '1,2,5').split(',').map(Number)) {
  if (!cases[scenario]) throw new Error(`Unknown scenario ${scenario}`)
  if (/^(commit|preflight|mixed)/.test(scenario) && !flags.write) throw new Error('Writing scenarios require explicit --write on disposable copied DB')
  const metricFile = resolve(work, 'runs', `${Date.now()}-${scenario}-c${concurrency}.metrics.jsonl`)
  const stderrFile = metricFile.replace('.metrics.jsonl', '.stderr.log')
  const child = fork(new URL('./worker.mjs', import.meta.url), { execArgv: ['--max-old-space-size=2048', '--experimental-transform-types'],
    env: { ...process.env, NODE_OPTIONS: '', PERF82_DB: dbPath, PERF82_WORK: work, PERF82_FILES: flags.files ?? '', PERF82_WRITE: flags.write ? '1' : '0', PERF82_METRICS: metricFile }, silent: true })
  const interrupt = () => { child.kill('SIGTERM'); process.exit(130) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let exit = null, ready = null, loopResolve
  const metrics = new Map()
  child.on('message', message => {
    if (message.type === 'ready') ready = message
    if (message.type === 'metric') metrics.set(message.value.id, message.value)
    if (message.type === 'loop') loopResolve?.(message.value)
  })
  child.stderr.on('data', bytes => appendFileSync(stderrFile, bytes, { mode: 0o600 }))
  child.stdout.on('data', () => {})
  const exited = new Promise(r => child.on('exit', (code, signal) => { exit = { code, signal }; r(exit) }))
  try {
    const startup = performance.now()
    while (!ready && !exit && performance.now() - startup < 30000) await new Promise(r => setTimeout(r, 20))
    if (!ready) throw new Error(exit ? 'worker_exited_during_startup' : 'startup_timeout')
    emit({ type: 'worker', scenario, concurrency, node: ready.node, actualHeapLimitBytes: ready.heapLimit })
    const url = `http://127.0.0.1:${ready.port}`
    for (let round = 0; round <= Number(flags.rounds ?? 5); round++) {
      const phase = round === 0 ? 'cold' : 'hot'
      const wall = performance.now()
      const responses = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const id = `${scenario}-${concurrency}-${round}-${index}`
        const item = cases[scenario].mixed ? (index % 2 ? cases.platform_key : cases.commit_1) : cases[scenario]
        const body = item.bodyFactory ? item.bodyFactory(id) : item.body
        const started = performance.now()
        try {
          const response = await fetch(url + item.path, { method: item.method ?? 'GET', headers: { 'x-perf82-id': id, ...(body ? { 'content-type': 'application/json', authorization: 'Bearer perf82-local-only' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Number(flags.timeout ?? 90000)) })
          const ttfbMs = performance.now() - started
          let bytes = 0
          const hash = createHash('sha256')
          const receiptChunks = item.expectedQueries ? [] : null
          for await (const chunk of response.body) { bytes += chunk.byteLength; hash.update(chunk); receiptChunks?.push(Buffer.from(chunk)) }
          const elapsedMs = performance.now() - started
          let receipt
          if (receiptChunks) {
            const data = JSON.parse(Buffer.concat(receiptChunks).toString('utf8'))
            receipt = { status: data.status, added: data.preflight?.add, conflicts: data.preflight?.conflicts?.length, written: data.summary?.written, failed: data.summary?.failed }
            if (item.action === 'commit' ? data.status !== 'committed' || data.summary?.failed !== 0 || data.summary?.written !== item.expectedQueries : data.status !== 'preflight' || data.preflight?.conflicts?.length !== 0 || data.preflight?.add !== item.expectedQueries) throw new Error('receipt_validation_failed')
          }
          return { id, status: response.status, elapsedMs, ttfbMs, receiveBodyMs: elapsedMs - ttfbMs, responseBytes: bytes, responseSha256: hash.digest('hex'), ...(receipt ? { receipt } : {}) }
        } catch (error) { return { id, error: error.name, ...(error.message === 'receipt_validation_failed' ? { validationError: error.message } : {}), elapsedMs: performance.now() - started } }
      }))
      // Process IPC metrics before assembling the batch, including body finish.
      await new Promise(r => setTimeout(r, 20))
      const loop = exit ? null : await Promise.race([new Promise(r => { loopResolve = r; child.send('loop') }), exited.then(() => null), new Promise(r => setTimeout(() => r(null), 3000))])
      const value = { type: 'batch', scenario, concurrency, phase, round, wallMs: performance.now() - wall, loop, dbBytes: statSync(dbPath).size, walBytes: existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').size : 0,
        responses: responses.map(response => ({ ...response, server: metrics.get(response.id) ?? null })) }
      emit(value)
      console.log(JSON.stringify({ scenario, concurrency, phase, statuses: responses.map(r => r.status ?? r.error), maxMs: Math.round(Math.max(...responses.map(r => r.elapsedMs))), heapMiB: Math.round(Math.max(...responses.map(r => metrics.get(r.id)?.heapPeak ?? 0)) / 2 ** 20) }))
      metrics.clear()
      if (responses.some(r => r.error) || exit) throw new Error('request_or_worker_failed')
    }
  } catch (error) {
    const last = existsSync(metricFile) ? readFileSync(metricFile, 'utf8').trim().split('\n').slice(-1).map(line => { try { return JSON.parse(line) } catch { return null } })[0] : null
    // Only classify OOM from V8 fatal signature; a connection reset alone is not proof.
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : ''
    emit({ type: 'failure', scenario, concurrency, reason: error.message, exit, oom: /heap out of memory|Reached heap limit|Ineffective mark-compacts/.test(stderr), lastCheckpoint: last })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (!exit) child.kill('SIGTERM')
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))])
    if (!exit) {
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise(r => setTimeout(r, 30000))])
      if (!exit) { emit({ type: 'runner-stop', reason: 'owned_worker_did_not_exit_after_SIGKILL; no further workers spawned', scenario, concurrency, pid: child.pid }); process.exit(2) }
    }
  }
}
