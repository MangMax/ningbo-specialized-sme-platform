import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as pause } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { seedDifferenceReadFixture, assertDifferenceReadState, m2Name, m2Note } from './fixtures/difference-read-boundaries'

// Real HTTP route + native driver. Only observation and lifecycle control are
// injected: no reader result, query, timeout or application budget is replaced.
it('REST differences native lock leaves health responsive before independent release and preserves exact nonempty JSON', async () => {
  const root = process.env.M2_SOURCE_ROOT ?? process.cwd(), dir = mkdtempSync(join(tmpdir(), 'differences-m2-http-'))
  const allNative=join(dir,'all-native.jsonl')
  const marker = join(dir, 'native.jsonl'), released = join(dir, 'released')
  const fault = join(dir,'exit-on-read')
  const preload = join(dir, 'observe.cjs'), boot = join(dir, 'app.mjs')
  const children: ChildProcess[] = []
  try {
    const req = createRequire(import.meta.url), driver = req.resolve('better-sqlite3')
    const jiti = createRequire(req.resolve('nuxt/package.json')).resolve('jiti')
    let output = ''
    writeFileSync(preload, `const fs=require('node:fs'),drivers=[...new Set([require(${JSON.stringify(driver)}),require(${JSON.stringify(createRequire(resolve('.output/server/package.json')).resolve('better-sqlite3'))})])];for(const D of drivers){const p=D.prototype.prepare,g=D.prototype.pragma;
      D.prototype.pragma=function(sql,...a){if(sql==='user_version'){const entry=JSON.stringify({pid:process.pid,kind:'admission',sql,at:Date.now()})+'\\n';fs.appendFileSync(${JSON.stringify(marker)},entry);fs.appendFileSync(${JSON.stringify(allNative)},entry)}return g.call(this,sql,...a)};
      D.prototype.prepare=function(sql,...a){if(sql.includes('from "difference_reason" where not exists')){const entry=JSON.stringify({pid:process.pid,kind:'source',sql,at:Date.now()})+'\\n';fs.appendFileSync(${JSON.stringify(marker)},entry);fs.appendFileSync(${JSON.stringify(allNative)},entry);if(process.env.M2_APP_PID&&process.pid!==Number(process.env.M2_APP_PID)&&fs.existsSync(${JSON.stringify(fault)}))process.exit(97)}return p.call(this,sql,...a)};}`)
    writeFileSync(boot, `import {createRequire} from 'node:module';import {createServer} from 'node:http';
      const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))}); const h=require('h3');
      Object.assign(globalThis,h,{defineRouteMeta:()=>{},defineNitroPlugin:f=>f,useRuntimeConfig:()=>({apiToken:'synthetic-m2'})});process.env.M2_APP_PID=String(process.pid);
      const {createJiti}=require(${JSON.stringify(jiti)});const load=createJiti(${JSON.stringify(resolve(root, 'package.json'))},{alias:{'@db':${JSON.stringify(resolve(root, 'db/index.ts'))},'~~':${JSON.stringify(root)},'#sme-roster':${JSON.stringify(resolve(root, 'layers/sme-roster'))}}});
      (await load.import(${JSON.stringify(resolve(root, 'tests/support/compiled-business-workers.ts'))})).installCompiledBusinessWorkers();
(await load.import(${JSON.stringify(resolve(root, 'server/install-application.ts'))})).installApplicationServer();
      const {initializeDb}=await load.import(${JSON.stringify(resolve(root, 'db/client.ts'))});
      const writer=initializeDb({create:true,readOnly:false});writer.$client.pragma('journal_mode=DELETE');
      const {startRosterApi}=await load.import(${JSON.stringify(resolve(root, 'tests/roster/imports/fixtures/import-server.ts'))});
      const imports=await startRosterApi({db:writer,apiToken:'synthetic-m2'});
      process.env.NUXT_DB_READONLY='1';
      const hooks={};(await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/plugins/enterprise-read.ts'))})).default({hooks:{hook:(n,f)=>hooks[n]=f}});
      const route=(await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/api/roster/differences.get.ts'))})).default;
      const recognitions=(await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/api/roster/recognitions.get.ts'))})).default;
      const history=(await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/api/roster/decision-lifecycle/history.get.ts'))})).default;
      const enterprises=(await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/api/roster/enterprises.get.ts'))})).default;
      const app=h.createApp({debug:false});app.use(h.defineEventHandler(e=>hooks.request(e)));
      app.use(h.createRouter().get('/api/roster/differences',route).get('/api/roster/recognitions',recognitions).get('/api/roster/decision-lifecycle/history',history).get('/api/roster/enterprises',enterprises).get('/api/health',h.defineEventHandler(()=>({ok:true}))));
      const server=createServer(h.toNodeListener(app));await new Promise(r=>server.listen(0,'127.0.0.1',r));
      console.log(JSON.stringify({port:server.address().port,imports:imports.baseUrl,pid:process.pid}));
      process.on('SIGTERM',async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await imports.close();await hooks.close();writer.$client.close();process.exit(0)});`)
    const app = spawn(process.execPath, [boot], { cwd: root, env: { ...process.env, NUXT_DB_PATH: join(dir, 'fixture.db'), NODE_OPTIONS: `--require=${preload}` }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(app); app.stdout!.on('data', c => { output += c }); app.stderr!.on('data', c => { output += c })
    let info: { port: number; imports: string; pid: number } | undefined
    for (let i=0; i<400 && !info; i++) { for (const line of output.split('\n')) { try { const v=JSON.parse(line); if (v.port) info=v } catch {} } if (!info) await pause(25) }
    expect(info, output).toBeDefined()
    const base = `http://127.0.0.1:${info!.port}`
    const request = { idempotencyKey: 'm2-native', sourceKind: 'announcement', sourceIdentity: 'synthetic/m2', payload: { announcement: {
      sourceDocument: { source: 'jxj', title: '合成 M2 原生锁' }, records: [{ enterprise: { name: '合成M2企业' }, titleCode: 'specialized_sme', events: [
        { eventType: 'award', year: 2021, evidence: [{ sourceFile: 'synthetic/m2.pdf', attachment: '附件一', listNo: 7, page: 3 }] },
      ] }],
    } } }
    const post = (action: string) => fetch(`${info!.imports}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-m2', 'content-type': 'application/json' }, body: JSON.stringify(request) })
    expect((await post('preflight')).status).toBe(200)
    const receipt = await (await post('commit')).json()
    expect(receipt.status).toBe('committed')
    expect((await fetch(base+'/api/health')).status).toBe(200)
    const warm = await fetch(base+'/api/roster/differences?pageSize=1'), expected = await warm.text()
    expect(JSON.parse(expected)).toMatchObject({ total: 1, counts: { little_giant: {missing_in_miit:0,extra_in_miit:0}, specialized_sme: {missing_in_miit:1,extra_in_miit:0}, innovative_sme: {missing_in_miit:0,extra_in_miit:0} }, page: 1, pageSize: 1, rows: [{ name: '合成M2企业', status: 'not_queried', explanationId: null, evidence: null, assessment:'not_queried', queryCoverage:{status:'not_queried',sources:[],truncated:false},currentDecision:{versionId:null,current:null} }] })
    writeFileSync(marker, '')
    for (const [query,statusMessage] of [['title=invalid','Unknown title; expected little_giant, specialized_sme, innovative_sme'],['status=invalid','Unknown status; expected not_queried, query_failed, no_record, confirmed_no_diff, confirmed_reason, needs_review']]) {
      const invalid=await fetch(base+'/api/roster/differences?'+query)
      expect(invalid.status).toBe(400);expect((await invalid.json()).statusMessage).toBe(statusMessage)
    }
    expect(readFileSync(marker,'utf8')).toBe('')
    const holder = spawn(process.execPath, ['-e', `const D=require(${JSON.stringify(driver)}),fs=require('node:fs'),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();fs.writeFileSync(${JSON.stringify(released)},String(Date.now()))},800);`], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    await once(holder.stdout!, 'data')
    let complete = false
    const pending = fetch(base+'/api/roster/differences?pageSize=1').then(r => { complete=true; return r })
    for (let i=0; i<200 && !readFileSync(marker,'utf8'); i++) await pause(2)
    const entries = readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    // Final-schema admission is the first worker read under this exclusive lock.
    expect(entries[0]).toMatchObject({kind:'admission',sql:'user_version'})
    const started=performance.now(), health=await fetch(base+'/api/health'), healthMs=performance.now()-started
    const beforeRelease=!existsSync(released), pendingAtHealth=!complete
    const response=await pending
    expect(response.headers.get('content-type')).toBe(warm.headers.get('content-type'))
    expect(await response.text()).toBe(expected)
    process.stdout.write('M2 native HTTP observation '+JSON.stringify({ appPid: info!.pid, nativePid: entries[0].pid, sql: entries[0].sql, healthMs, beforeRelease, pendingAtHealth, healthStatus: health.status, bodySha256:createHash('sha256').update(expected).digest('hex') })+'\n')
    expect(health.status).toBe(200)
    expect(healthMs).toBeLessThan(300)
    expect(beforeRelease).toBe(true)
    expect(pendingAtHealth).toBe(true)
    expect(entries[0].pid).not.toBe(info!.pid)
    // Acknowledged API commits become visible on the retained child connection.
    const another={...request,idempotencyKey:'m2-next',sourceIdentity:'synthetic/m2-next',payload:{announcement:{...request.payload.announcement,records:[{...request.payload.announcement.records[0]!,enterprise:{name:'另一合成M2企业'}}]}}}
    const commit=async(body:unknown)=> (await fetch(`${info!.imports}/api/roster/import/commit`,{method:'POST',headers:{authorization:'Bearer synthetic-m2','content-type':'application/json'},body:JSON.stringify(body)})).json()
    expect((await commit(another)).status).toBe('committed')
    for(let n=0;n<3;n++)expect(await (await fetch(base+'/api/roster/differences')).json()).toMatchObject({total:2,rows:[{name:'另一合成M2企业'},{name:'合成M2企业'}]})
    const failed={...another,idempotencyKey:'m2-rollback',sourceIdentity:'synthetic/m2-rollback',payload:{announcement:{...another.payload.announcement,records:[{...another.payload.announcement.records[0]!,enterprise:{name:'不得部分提交合成企业'}},{...another.payload.announcement.records[0]!,enterprise:{name:'非法称号合成企业'},titleCode:'invalid'}]}}}
    expect((await commit(failed)).status).toBe('failed')
    const afterRollback=await (await fetch(base+'/api/roster/differences?pageSize=999')).json()
    expect(afterRollback).toMatchObject({pageSize:200,total:2,rows:[{name:'另一合成M2企业'},{name:'合成M2企业'}]})
    expect(afterRollback.rows).toHaveLength(2)
    // No reader substitution: a real native busy error must return once, before
    // the independent lock release, rather than replaying on the original owner.
    if(holder.exitCode===null)await once(holder,'exit')
    writeFileSync(marker,'')
    rmSync(released,{force:true})
    const busy=spawn(process.execPath,['-e',`const D=require(${JSON.stringify(driver)}),fs=require('node:fs'),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();fs.writeFileSync(${JSON.stringify(released)},'released')},5800);`],{stdio:['ignore','pipe','pipe']})
    children.push(busy);await once(busy.stdout!,'data')
    const failure=await fetch(base+'/api/roster/differences')
    expect(failure.status).toBe(500)
    expect(await failure.json()).toMatchObject({statusCode:500})
    expect(existsSync(released)).toBe(false)
    const failedEntries=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    expect(failedEntries).toHaveLength(1);expect(failedEntries[0].pid).not.toBe(info!.pid)
    if(busy.exitCode===null)await once(busy,'exit')
    writeFileSync(marker,'');writeFileSync(fault,'exit before native invocation')
    const recovered=await fetch(base+'/api/roster/differences?pageSize=999')
    expect(recovered.status).toBe(200);expect(await recovered.json()).toEqual(afterRollback)
    const recoveryEntries=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    const mainEntries=recoveryEntries.filter(x=>x.kind==='source'&&x.pid===info!.pid)
    expect(mainEntries).toHaveLength(1) // one whole original REST invocation
    expect(recoveryEntries.filter(x=>x.kind==='source'&&x.pid!==info!.pid)).toHaveLength(1)
    rmSync(fault)
    const restarted=await fetch(base+'/api/roster/differences?pageSize=999')
    expect(await restarted.json()).toEqual(afterRollback)
    writeFileSync(marker,'')
    const cancelLock=spawn(process.execPath,['-e',`const D=require(${JSON.stringify(driver)}),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close()},800)`],{stdio:['ignore','pipe','pipe']})
    children.push(cancelLock);await once(cancelLock.stdout!,'data')
    const controller=new AbortController()
    const cancelled=fetch(base+'/api/roster/differences',{signal:controller.signal}).then(()=>null,error=>error)
    for(let i=0;i<200&&!readFileSync(marker,'utf8');i++)await pause(2)
    const activePid=JSON.parse(readFileSync(marker,'utf8').trim().split('\n')[0]!).pid
    const recognition=fetch(base+'/api/roster/recognitions')
    const enterprise=fetch(base+'/api/roster/enterprises')
    controller.abort();expect((await cancelled)?.name).toBe('AbortError')
    expect(await (await recognition).json()).toMatchObject({counts:{titlePairs:2,enterprises:2}})
    const enterpriseResponse=await enterprise
    expect(enterpriseResponse.status).toBe(200)
    expect(await enterpriseResponse.json()).toMatchObject({counts:{total:2},rows:[{name:'另一合成M2企业'},{name:'合成M2企业'}]})
    const afterCancel=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    expect(afterCancel.every(x=>x.pid===activePid)).toBe(true)
    // A new independent fixture in the same owned DB, isolated by q/title.
    await seedDifferenceReadFixture(info!.imports, 'synthetic-m2')
    const richResponse=await fetch(base+'/api/roster/differences?q=M2R')
    expect(richResponse.headers.get('cache-control')).toBe('no-store')
    const richText=await richResponse.text(), rich=JSON.parse(richText)
    assertDifferenceReadState(rich)
    expect(Buffer.byteLength(richText)).toBeGreaterThan(65536)
    for(const r of rich.rows.slice(0,16))expect(r.reasonNote).toBe(m2Note)
    const deep=await (await fetch(base+'/api/roster/differences?q=M2R&page=3&pageSize=5')).json()
    expect(deep).toMatchObject({total:17,page:3,pageSize:5,counts:rich.counts})
    expect(deep.rows.map((r:any)=>[r.name,r.direction])).toEqual(Array.from({length:5},(_,n)=>[m2Name(n+2),'missing_in_miit']))
    const alias=await (await fetch(base+'/api/roster/differences?q='+encodeURIComponent('M2R旧名称'))).json()
    expect(alias).toMatchObject({total:2,rows:[{name:m2Name(0)},{name:m2Name(0)}]})
    const filtered=await (await fetch(base+'/api/roster/differences?reason=pending_review&status=confirmed_reason&title=specialized_sme&direction=missing_in_miit')).json()
    expect(filtered.total).toBe(1);expect(filtered.rows[0]).toEqual(rich.rows[8])
    expect(rich.rows[8].queryCoverage.sources.map((x:any)=>x.queryId)).toEqual([rich.rows[8].evidence.queryId+1,rich.rows[8].evidence.queryId])
    const coordinate={enterpriseId:rich.rows[8].enterpriseId,titleCode:'specialized_sme',direction:'missing_in_miit'}
    const history=await (await fetch(base+'/api/roster/decision-lifecycle/history?'+new URLSearchParams(Object.entries(coordinate).map(([k,v])=>[k,String(v)])))).json()
    expect(history).toMatchObject({total:2,rows:[{status:'confirmed_reason'},{status:'needs_review'}]})
  } finally {
    let nativePids: number[] = []
    try {
      for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') }
      // Observation is diagnostic: a read/parse failure must not skip removal.
      try { nativePids=existsSync(allNative)?[...new Set(readFileSync(allNative,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).pid as number))]:[] } catch {}
    } finally { rmSync(dir,{recursive:true,force:true}) }
    for(let n=0;n<100&&nativePids.some(pid=>{try{process.kill(pid,0);return true}catch{return false}});n++)await pause(10)
    const remaining=[...children.map(x=>x.pid),...nativePids].filter(pid=>{if(!pid)return false;try{process.kill(pid,0);return true}catch{return false}})
    // Portable, best-effort diagnostics cannot mask a native assertion failure.
    try { process.stdout.write('M2 owned HTTP cleanup '+JSON.stringify({dir,pids:children.map(x=>x.pid),nativePids,remaining,removed:!existsSync(dir)})+'\n') } catch {}
    expect(remaining).toEqual([]);expect(existsSync(dir)).toBe(false)
  }
}, 30000)
