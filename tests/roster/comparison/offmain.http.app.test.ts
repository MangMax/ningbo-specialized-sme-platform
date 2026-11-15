import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { assertWorkerComparisonState, m3Raw, workerReconciliationSnapshot, seedWorkerComparisonFixture } from './fixtures/worker-isolation'
import { comparisonWorkerObserver } from './fixtures/worker-observer'

it('whole summary keeps an independent HTTP probe responsive and preserves SQL files errors full evidence and acknowledged snapshots', async () => {
  const root = process.env.M3_SOURCE_ROOT ?? process.cwd(), dir = mkdtempSync(join(tmpdir(), 'comparison-m3-http-'))
  const children: ChildProcess[] = [], dbPath = join(dir, 'fixture.db'), observed = join(dir, 'observed.jsonl')
  let logs = '', nativePids: number[] = []
  try {
    const req = createRequire(import.meta.url), bundled = process.env.M3_BUNDLED_ROOT
    let driver = req.resolve('better-sqlite3'), entry: string, cwd = root
    const preload = join(dir, 'observe.cjs'), curated = join(dir, 'curated.json'), reconcile = join(dir, 'reconcile.json')
    if (bundled) {
      cwd = join(dir, 'other-cwd'); mkdirSync(join(cwd, 'db'), { recursive: true })
      cpSync(resolve(root, 'db/migrations'), join(cwd, 'db/migrations'), { recursive: true })
      const out = join(dir, 'relocated'); cpSync(bundled, out, { recursive: true })
      entry = join(out, 'server/index.mjs'); driver = createRequire(join(out, 'server/package.json')).resolve('better-sqlite3')
    } else {
      entry = join(dir, 'app.mjs')
      const jiti = createRequire(req.resolve('nuxt/package.json')).resolve('jiti')
      writeFileSync(entry, `import {createRequire} from 'node:module';import {createServer} from 'node:http';
const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))}),h=require('h3');
Object.assign(globalThis,h,{defineRouteMeta:()=>{},defineNitroPlugin:f=>f,useRuntimeConfig:()=>({apiToken:'synthetic-m3',curatedPath:${JSON.stringify(curated)},reconcilePath:${JSON.stringify(reconcile)}})});
const {createJiti}=require(${JSON.stringify(jiti)}),load=createJiti(${JSON.stringify(resolve(root, 'package.json'))},{alias:{'@db':${JSON.stringify(resolve(root, 'db/index.ts'))},'~~':${JSON.stringify(root)}}});
const {initializeDb}=await load.import(${JSON.stringify(resolve(root, 'db/client.ts'))}),writer=initializeDb({create:true,readOnly:false});
const {startRosterApi,executeNativeImport}=await load.import(${JSON.stringify(resolve(root, 'tests/roster/imports/fixtures/import-server.ts'))}),imports=await startRosterApi({db:writer,apiToken:'synthetic-m3',executeImport:executeNativeImport});
const hooks={};(await load.import(${JSON.stringify(resolve(root, 'server/plugins/enterprise-read.ts'))})).default({hooks:{hook:(n,f)=>hooks[n]=f}});
const router=h.createRouter();for(const [path,file] of [['/api/comparison','comparison.get.ts'],['/api/platform/queries/:queryId/evidence','platform/queries/[queryId]/evidence.get.ts'],['/api/roster/recognitions','roster/recognitions.get.ts'],['/api/roster/differences','roster/differences.get.ts'],['/api/roster/enterprises','roster/enterprises.get.ts']])router.get(path,(await load.import(${JSON.stringify(resolve(root, 'server/api'))}+'/'+file)).default);
router.patch('/api/comparison/curated',(await load.import(${JSON.stringify(resolve(root, 'server/api/comparison/curated.patch.ts'))})).default);router.get('/api/health',h.defineEventHandler(()=>({ok:true})));
const app=h.createApp({debug:false});app.use(h.defineEventHandler(e=>hooks.request(e)));app.use(router);const server=createServer(h.toNodeListener(app));await new Promise(r=>server.listen(Number(process.env.NITRO_PORT),'127.0.0.1',r));console.log(JSON.stringify({imports:imports.baseUrl}));
process.on('SIGTERM',async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await imports.close();await hooks.close();writer.$client.close();process.exit(0)});`)
    }
    writeFileSync(preload, comparisonWorkerObserver(driver, dir, dbPath)); writeFileSync(observed, ''); writeFileSync(join(dir, 'delete-journal'), '')
    const portServer = createServer(); await new Promise<void>(r => portServer.listen(0, '127.0.0.1', r))
    const port = (portServer.address() as { port: number }).port; await new Promise<void>(r => portServer.close(() => r()))
    const base = `http://127.0.0.1:${port}`
    const spawnOwned = (args: string[], env: Record<string, string> = {}) => {
      const child = spawn(process.execPath, args, { cwd, env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-m3', NUXT_CURATED_PATH: curated, NUXT_RECONCILE_PATH: reconcile, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child); child.stdout!.on('data', c => { logs += c }); child.stderr!.on('data', c => { logs += c }); return child
    }
    const stop = async (p: ChildProcess) => { if (p.exitCode === null && p.signalCode === null) { p.kill('SIGTERM'); await once(p, 'exit') } }
    const start = async () => {
      logs = ''; const app = spawnOwned([entry])
      for (let n = 0; n < 600; n++) { try { if ((await fetch(base + '/api/health')).ok) return app } catch {} if (app.exitCode !== null) throw new Error(logs); await pause(25) }
      throw new Error('M3 readiness: ' + logs)
    }
    const entries = () => readFileSync(observed, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x))
    const clear = () => writeFileSync(observed, '')
    const waitEntry = async (kind: string) => { for (let n = 0; n < 500 && !entries().some(e => e.kind === kind); n++) await pause(2); expect(entries().some(e => e.kind === kind), logs).toBe(true) }
    const read = async (query = '?view=summary') => {
      const r = await fetch(base + '/api/comparison' + query)
      return { status: r.status, statusText: r.statusText, headers: Object.fromEntries([...r.headers].filter(([key]) => !['date', 'connection', 'keep-alive'].includes(key))), text: await r.text() }
    }
    const json = async (query = '?view=summary') => { const r = await read(query); expect(r.status, r.text).toBe(200); return JSON.parse(r.text) }
    const lock = async (ms: number) => {
      rmSync(join(dir, 'released'), { force: true })
      const child = spawnOwned(['-e', `const D=require(${JSON.stringify(driver)}),fs=require('node:fs'),db=new D(${JSON.stringify(dbPath)});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();fs.writeFileSync(${JSON.stringify(join(dir, 'released'))},'released')},${ms})`])
      await once(child.stdout!, 'data'); return child
    }
    const first = await start()
    const imports = bundled ? base : JSON.parse(logs.split('\n').find(x => x.startsWith('{"imports"'))!).imports
    await seedWorkerComparisonFixture(imports, 'synthetic-m3')
    for (const curated of [true, false]) {
      const r = await fetch(base + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nameNorm: 'M3Beta企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated }) })
      expect(r.status).toBe(200); expect(await r.json()).toEqual({ curated })
    }
    writeFileSync(reconcile, workerReconciliationSnapshot())
    const expected = await read(), full = await read(''), explicitFull = await read('?view=full')
    assertWorkerComparisonState(JSON.parse(expected.text)); expect(explicitFull).toEqual(full)
    expect(entries().filter(e => e.kind === 'source').every(e => e.pid === first.pid)).toBe(true)
    // The first managed open created the file and is conservatively ineligible.
    expect(entries().some(e => e.kind === 'source' && e.pid === first.pid)).toBe(true)
    let originalBusy: Awaited<ReturnType<typeof read>> | undefined, originalSyntax: Awaited<ReturnType<typeof read>> | undefined
    if (!process.env.M3_RED_ONLY) {
      const validCuration = readFileSync(curated)
      writeFileSync(curated, '{broken'); originalSyntax = await read(); expect(originalSyntax.status).toBe(500); writeFileSync(curated, validCuration)
      clear(); const holder = await lock(5800); originalBusy = await read(); expect(originalBusy.status).toBe(500); expect(existsSync(join(dir, 'released'))).toBe(false)
      expect(entries().filter(e => e.kind === 'source')).toMatchObject([{ pid: first.pid }]); if (holder.exitCode === null) await once(holder, 'exit')
    }
    await stop(first)
    const app = await start(); expect((await read())).toEqual(expected); clear()
    // True RED at the pinned source: the same route still blocks the main loop.
    const holder = await lock(850)
    let complete = false
    const pending = read().then(r => { complete = true; return r })
    await waitEntry('admission')
    // Production health itself reads this locked DB. Its existing smoke query
    // is not an independent event-loop probe; use an unchanged static resource
    // in the bundled lane. Source RED/GREEN retains the independent health route.
    const probePath = bundled ? '/favicon.svg' : '/api/health'
    const started = performance.now(), health = await fetch(base + probePath), healthMs = performance.now() - started
    const beforeRelease = !existsSync(join(dir, 'released')), pendingAtHealth = !complete
    expect(await pending).toEqual(expected)
    const native = entries().find(e => e.kind === 'source')
    try { process.stdout.write('M3 native HTTP ' + JSON.stringify({ bundled: !!bundled, probePath, appPid: app.pid, nativePid: native.pid, healthMs, beforeRelease, pendingAtHealth, healthStatus: health.status }) + '\n') } catch {}
    expect(health.status).toBe(200); expect(healthMs).toBeLessThan(300); expect(beforeRelease).toBe(true); expect(pendingAtHealth).toBe(true); expect(native.pid).not.toBe(app.pid)
    for (const kind of ['source', 'hydration', 'file']) expect(entries().filter(e => e.kind === kind).every(e => e.pid === native.pid)).toBe(true)
    expect(entries().filter(e => e.kind === 'file').map(e => e.file)).toEqual([curated, reconcile])
    expect(entries().some(e => e.kind === 'hydration')).toBe(true)
    if (holder.exitCode === null) await once(holder, 'exit')
    if (process.env.M3_RED_ONLY) return
    // Actual child filters retain global counts and pre-pagination evidence counts.
    const global = await json(); assertWorkerComparisonState(global)
    for (const q of ['q=M3Alpha%20旧名', 'q=94457p', 'q=M3待核旧名', 'district=余姚市', 'title=innovative_sme', 'direction=extra_in_miit', 'title=specialized_sme,innovative_sme', 'page=2&pageSize=1', 'page=99&pageSize=1', 'q=M3Alpha旧名&district=镇海区']) {
      const fullFiltered = await json('?' + q), summary = await json('?view=summary&' + q)
      expect(summary.rows.map((r: any) => r.enterpriseId)).toEqual(fullFiltered.rows.map((r: any) => r.enterpriseId))
      expect(summary).toMatchObject({ total: fullFiltered.total, counts: global.counts, curatedCounts: global.curatedCounts, platform: fullFiltered.platform, reconcile: fullFiltered.reconcile })
    }
    expect(await json('?view=summary&enterpriseId=999999')).toMatchObject({ total: 0, rows: [], counts: global.counts, curatedCounts: global.curatedCounts, platform: { withEvidence: 0, withExplanation: 0, withoutExplanation: 0 } })
    const alpha = global.rows[0], detail = await json(alpha.detailUrl.slice('/api/comparison'.length))
    expect(detail.total).toBe(1); expect(detail.rows[0]).toEqual(JSON.parse(full.text).rows[0]); expect(detail.rows[0].platform.queries[0].relations[0].rawFields.large).toBe(m3Raw)
    expect(detail.rows[0].platform.queries[0].relations[1]).toMatchObject({ matchBasis: 'none', verificationStatus: 'pending', rawFields: { original: 'M3未分配原文' } })
    expect(detail.rows[0].platform.queries[0].relations[2]).toMatchObject({ verificationStatus: 'pending', rawFields: { original: 'M3关联候选原文' } })
    const queryId = detail.rows[0].platform.queries[0].id
    const evidence = await (await fetch(base + `/api/platform/queries/${queryId}/evidence?field=relations&pageSize=1&page=2`)).json()
    expect(evidence).toMatchObject({ total: 3, rows: [{ sequenceNo: 2 }] })
    const rawEvidence = await (await fetch(base + `/api/platform/queries/${queryId}/evidence?field=relation&relationId=${evidence.rows[0].id}`)).json()
    expect(JSON.parse(Buffer.from(rawEvidence.data, 'base64').toString())).toMatchObject({ enterpriseId: null, rawFields: { original: 'M3未分配原文' } })
    clear()
    for (const [q, message] of [['view=invalid', 'view must be full or summary'], ['view=summary&enterpriseId=0', 'enterpriseId must be a positive integer'], ['view=summary&showCurated=no', 'showCurated must be true or false'], ['view=summary&direction=bad', 'Unknown direction; expected missing_in_miit, extra_in_miit'], ['view=summary&title=bad', 'Unknown title; expected little_giant, specialized_sme, innovative_sme']]) {
      const r = await read('?' + q); expect(r.status).toBe(400); expect(JSON.parse(r.text).statusMessage).toBe(message)
    }
    expect(entries()).toEqual([])
    const curate = async (curated: boolean, note = 'M3人工备注') => {
      const r = await fetch(base + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nameNorm: 'M3Beta企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated, note }) })
      expect(r.status).toBe(200); expect(await r.json()).toEqual({ curated })
    }
    await curate(true); expect(await json()).toMatchObject({ total: 2, curatedCounts: { specialized_sme: { missing_in_miit: 1 } } })
    const included = await json('?view=summary&showCurated=true&district=余姚市'); expect(included.rows[0]).toMatchObject({ name: 'M3Beta企业', curated: true }); expect(included.rows[0]).not.toHaveProperty('note')
    await curate(true, 'M3已更新备注'); expect((await json(included.rows[0].detailUrl.slice('/api/comparison'.length))).rows[0].note).toBe('M3已更新备注')
    await curate(false); expect(await read()).toEqual(expected)
    writeFileSync(join(dir, 'new-cache'), workerReconciliationSnapshot('pending_review', 'M3-cache-2')); renameSync(join(dir, 'new-cache'), reconcile)
    const refreshed = await json()
    expect(refreshed.reconcile).toEqual({ generatedAt: 'M3-cache-2', matched: 1 }); expect(refreshed.rows[0].explanation).toEqual({ code: 'pending_review' })
    // Invalid, absent and unreadable reconcile all retain the old EMPTY result.
    for (const fault of ['invalid', 'absent', 'directory']) {
      rmSync(reconcile, { recursive: true, force: true }); if (fault === 'invalid') writeFileSync(reconcile, '{broken'); if (fault === 'directory') mkdirSync(reconcile)
      const empty = await json()
      expect(empty).toMatchObject({ total: 3, reconcile: { generatedAt: null, matched: 0 } }); expect(empty.rows.every((r: any) => r.explanation === null)).toBe(true)
    }
    rmSync(reconcile, { recursive: true, force: true }); writeFileSync(reconcile, workerReconciliationSnapshot()); rmSync(curated, { force: true }); expect(await read()).toEqual(expected)
    // Repair immediately AFTER the real read returns malformed bytes. A replay
    // would now succeed, so public500 plus one child source read proves terminal.
    clear(); writeFileSync(curated, '{broken'); writeFileSync(join(dir, 'repair-curation'), '')
    expect(await read()).toEqual(originalSyntax); expect(readFileSync(curated, 'utf8')).toBe('{}')
    expect(entries().filter(e => e.kind === 'source')).toMatchObject([{ pid: native.pid }]); expect(entries().filter(e => e.kind === 'source')).toHaveLength(1)
    rmSync(join(dir, 'repair-curation')); rmSync(curated)
    clear(); const busy = await lock(5800); expect(await read()).toEqual(originalBusy); expect(existsSync(join(dir, 'released'))).toBe(false)
    // Admission itself is the first native read blocked by the exclusive lock.
    expect(entries().filter(e => e.kind === 'admission')).toHaveLength(1)
    expect(entries().find(e => e.kind === 'admission').pid).not.toBe(app.pid)
    expect(entries().filter(e => e.kind === 'source')).toHaveLength(0)
    if (busy.exitCode === null) await once(busy, 'exit')
    clear(); writeFileSync(join(dir, 'exit-on-read'), '')
    // Exit marker is observed before the native invocation, an infrastructure fault.
    // The inherited app PID restricts this fault to the actual child process.
    expect(await read()).toEqual(expected); rmSync(join(dir, 'exit-on-read'))
    expect(entries().filter(e => e.kind === 'source' && e.pid === app.pid)).toHaveLength(1)
    expect(entries().filter(e => e.kind === 'source' && e.pid !== app.pid)).toHaveLength(1)
    expect(await read()).toEqual(expected)
    expect(await read('')).toEqual(full); expect(await read('?view=full')).toEqual(full)
    // A successful response may still be the original-reader fallback after
    // startup failure. Establish native recovery before testing warm cancellation.
    clear(); expect(await read()).toEqual(expected)
    const recoveredSources = entries().filter(e => e.kind === 'source')
    expect(recoveredSources, logs).toHaveLength(1)
    expect(recoveredSources[0].pid).not.toBe(app.pid)
    // Real active and queued HTTP aborts: the shared child drains the active
    // native read, and subsequent recognition/REST/enterprise work survives.
    clear(); const cancelHolder = await lock(850), activeAbort = new AbortController(), queuedAbort = new AbortController()
    const cancelled = fetch(base + '/api/comparison?view=summary', { signal: activeAbort.signal }).then(() => null, error => error)
    await waitEntry('admission')
    const activePid = entries().find(e => e.kind === 'admission').pid
    const queuedCancel = fetch(base + '/api/comparison?view=summary', { signal: queuedAbort.signal }).then(() => null, error => error)
    const mixed = ['/api/roster/recognitions', '/api/roster/differences', '/api/roster/enterprises'].map(path => fetch(base + path))
    queuedAbort.abort(); activeAbort.abort()
    expect((await queuedCancel)?.name).toBe('AbortError'); expect((await cancelled)?.name).toBe('AbortError')
    for (const response of await Promise.all(mixed)) expect(response.status).toBe(200)
    expect(await read()).toEqual(expected)
    expect(entries().filter(e => e.kind === 'source').every(e => e.pid === activePid)).toBe(true)
    expect(activePid).not.toBe(app.pid)
    if (cancelHolder.exitCode === null) await once(cancelHolder, 'exit')
    // Reopen only this fixture in WAL. The production journal policy is untouched.
    await stop(app); rmSync(join(dir, 'delete-journal')); const walApp = await start(); await read(); clear()
    writeFileSync(join(dir, 'pause-after-source'), '')
    const snapshot = read(); await waitEntry('snapshot-established')
    const walImports = bundled ? base : JSON.parse(logs.split('\n').find(x => x.startsWith('{"imports"'))!).imports
    const commit = await fetch(walImports + '/api/roster/import/commit', { method: 'POST', headers: { authorization: 'Bearer synthetic-m3', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'm3-snapshot-next', sourceKind: 'announcement', sourceIdentity: 'synthetic/snapshot', payload: { aliases: [{ enterpriseName: 'M3Alpha企业', name: 'M3并发已确认别名', sourceKind: 'manual', verificationStatus: 'confirmed' }], differences: [{ enterpriseName: 'M3Alpha企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', verificationStatus: 'pending', recordedAt: '2026-10-21T00:00:00Z' }], announcement: { sourceDocument: { source: 'jxj', title: 'M3并发公布' }, records: [{ enterprise: { name: 'M3新提交企业' }, titleCode: 'innovative_sme', events: [] }] } } }) })
    expect(commit.status).toBe(200); expect(await commit.json()).toMatchObject({ status: 'committed' })
    expect(entries().find(e => e.kind === 'snapshot-established').pid).not.toBe(walApp.pid)
    writeFileSync(join(dir, 'release-snapshot'), '')
    expect(await snapshot).toEqual(expected)
    const next = await json(); expect(next.total).toBe(4); expect(next.counts.innovative_sme.missing_in_miit).toBe(2); expect(next.rows[0].platform).toMatchObject({ aliasCount: 3, confirmedAliasCount: 2, disposition: { status: 'needs_review', verificationStatus: 'pending' } })
    const failed = await fetch(walImports + '/api/roster/import/commit', { method: 'POST', headers: { authorization: 'Bearer synthetic-m3', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'm3-rollback', sourceKind: 'announcement', sourceIdentity: 'synthetic/rollback', payload: { announcement: { sourceDocument: { source: 'jxj', title: 'M3整批回滚' }, records: [{ enterprise: { name: 'M3不得部分泄漏' }, titleCode: 'innovative_sme', events: [] }, { enterprise: { name: 'M3非法称号' }, titleCode: 'invalid', events: [] }] } } }) })
    expect(await failed.json()).toMatchObject({ status: 'failed' }); expect(await json()).toEqual(next)
    // Unchanged recognition, REST differences and enterprise consumers still run.
    for (const path of ['/api/roster/recognitions', '/api/roster/differences', '/api/roster/enterprises']) expect((await fetch(base + path)).status).toBe(200)
    try { process.stdout.write('M3 summary parity and snapshot ' + JSON.stringify({ bundled: !!bundled, entry, cwd, total: next.total, originalPid: first.pid, childPid: native.pid, errorInventory: ['SyntaxError', 'SQLITE_BUSY'], fullBytes: Buffer.byteLength(full.text) }) + '\n') } catch {}
  } finally {
    try {
      // Unblock owned paused native work before orderly termination on failure.
      try { writeFileSync(join(dir, 'release-snapshot'), '') } catch {}
      for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
      try { nativePids = [...new Set(readFileSync(join(dir, 'all-observed.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x).pid as number))] } catch {}
    } finally { rmSync(dir, { recursive: true, force: true }) }
    const remaining = [...children.map(x => x.pid), ...nativePids].filter(pid => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } })
    try { process.stdout.write('M3 owned cleanup ' + JSON.stringify({ dir, pids: children.map(x => x.pid), nativePids, remaining, removed: !existsSync(dir) }) + '\n') } catch {}
    expect(remaining).toEqual([]); expect(existsSync(dir)).toBe(false)
  }
}, 90000)
