import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as pause } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

// Real HTTP route + native driver. Only observation and lifecycle control are
// injected: no reader result, query, timeout or application budget is replaced.
it('recognition native lock leaves health responsive before independent release and preserves exact nonempty JSON', async () => {
  const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'recognition-m1-http-'))
  const req = createRequire(import.meta.url), driver = req.resolve('better-sqlite3')
  const jiti = createRequire(req.resolve('nuxt/package.json')).resolve('jiti')
  const marker = join(dir, 'native.jsonl'), released = join(dir, 'released')
  const fault = join(dir,'exit-on-read')
  const preload = join(dir, 'observe.cjs'), boot = join(dir, 'app.mjs')
  const children: ChildProcess[] = []
  let output = ''
  writeFileSync(preload, `const fs=require('node:fs'),D=require(${JSON.stringify(driver)}),p=D.prototype.prepare;
    D.prototype.prepare=function(sql,...a){if(/record_event/.test(sql)){fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,sql,at:Date.now()})+'\\n');if(process.env.M1_APP_PID&&process.pid!==Number(process.env.M1_APP_PID)&&fs.existsSync(${JSON.stringify(fault)}))process.exit(97)}return p.call(this,sql,...a)};`)
  writeFileSync(boot, `import {createRequire} from 'node:module';import {createServer} from 'node:http';
    const require=createRequire(${JSON.stringify(resolve('package.json'))}); const h=require('h3');
    Object.assign(globalThis,h,{defineRouteMeta:()=>{},defineNitroPlugin:f=>f});process.env.M1_APP_PID=String(process.pid);
    const {createJiti}=require(${JSON.stringify(jiti)});const load=createJiti(${JSON.stringify(resolve('package.json'))},{alias:{'@db':${JSON.stringify(resolve('db/index.ts'))},'~~':${JSON.stringify(root)}}});
    const {initializeDb}=await load.import(${JSON.stringify(resolve('db/client.ts'))});
    const writer=initializeDb({readOnly:false});writer.$client.pragma('journal_mode=DELETE');
    const {startRosterApi}=await load.import(${JSON.stringify(resolve('tests/helpers/roster-http-server.ts'))});
    const imports=await startRosterApi({db:writer,apiToken:'synthetic-m1'});
    process.env.NUXT_DB_READONLY='1';
    const hooks={};(await load.import(${JSON.stringify(resolve('server/plugins/enterprise-read.ts'))})).default({hooks:{hook:(n,f)=>hooks[n]=f}});
    const route=(await load.import(${JSON.stringify(resolve('server/api/roster/recognitions.get.ts'))})).default;
    const enterprises=(await load.import(${JSON.stringify(resolve('server/api/roster/enterprises.get.ts'))})).default;
    const app=h.createApp({debug:false});app.use(h.defineEventHandler(e=>hooks.request(e)));
    app.use(h.createRouter().get('/api/roster/recognitions',route).get('/api/roster/enterprises',enterprises).get('/api/health',h.defineEventHandler(()=>({ok:true}))));
    const server=createServer(h.toNodeListener(app));await new Promise(r=>server.listen(0,'127.0.0.1',r));
    console.log(JSON.stringify({port:server.address().port,imports:imports.baseUrl,pid:process.pid}));
    process.on('SIGTERM',async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await imports.close();await hooks.close();writer.$client.close();process.exit(0)});`)
  try {
    const app = spawn(process.execPath, [boot], { cwd: root, env: { ...process.env, NUXT_DB_PATH: join(dir, 'fixture.db'), NODE_OPTIONS: `--require=${preload}` }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(app); app.stdout!.on('data', c => { output += c }); app.stderr!.on('data', c => { output += c })
    let info: { port: number; imports: string; pid: number } | undefined
    for (let i=0; i<400 && !info; i++) { for (const line of output.split('\n')) { try { const v=JSON.parse(line); if (v.port) info=v } catch {} } if (!info) await pause(25) }
    expect(info, output).toBeDefined()
    const base = `http://127.0.0.1:${info!.port}`
    const request = { idempotencyKey: 'm1-native', sourceKind: 'announcement', sourceIdentity: 'synthetic/m1', payload: { announcement: {
      sourceDocument: { source: 'jxj', title: '合成 M1 原生锁' }, records: [{ enterprise: { name: '合成M1企业' }, titleCode: 'specialized_sme', events: [
        { eventType: 'award', year: 2021, evidence: [{ sourceFile: 'synthetic/m1.pdf', attachment: '附件一', listNo: 7, page: 3 }] },
      ] }],
    } } }
    const post = (action: string) => fetch(`${info!.imports}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-m1', 'content-type': 'application/json' }, body: JSON.stringify(request) })
    expect((await post('preflight')).status).toBe(200)
    const receipt = await (await post('commit')).json()
    expect(receipt.status).toBe('committed')
    expect((await fetch(base+'/api/health')).status).toBe(200)
    const warm = await fetch(base+'/api/roster/recognitions?pageSize=1'), expected = await warm.text()
    expect(JSON.parse(expected)).toMatchObject({ counts: { titlePairs: 1, enterprises: 1, titles: { little_giant: 0, specialized_sme: 1, innovative_sme: 0 } }, page: 1, pageSize: 1, rows: [{ name: '合成M1企业', firstYear: 2021, status: 'confirmed', evidence: [{ sourceFile: 'synthetic/m1.pdf', attachment: '附件一', listNo: 7, page: 3 }] }] })
    writeFileSync(marker, '')
    for (const [query,statusMessage] of [['title=invalid','Unknown title; expected little_giant, specialized_sme, innovative_sme'],['status=invalid','Unknown status; expected confirmed, pending']]) {
      const invalid=await fetch(base+'/api/roster/recognitions?'+query)
      expect(invalid.status).toBe(400);expect((await invalid.json()).statusMessage).toBe(statusMessage)
    }
    expect(readFileSync(marker,'utf8')).toBe('')
    const holder = spawn(process.execPath, ['-e', `const D=require(${JSON.stringify(driver)}),fs=require('node:fs'),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();fs.writeFileSync(${JSON.stringify(released)},String(Date.now()))},800);`], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    await once(holder.stdout!, 'data')
    let complete = false
    const pending = fetch(base+'/api/roster/recognitions?pageSize=1').then(r => { complete=true; return r })
    for (let i=0; i<200 && !readFileSync(marker,'utf8'); i++) await pause(2)
    const entries = readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    expect(entries[0].sql).toMatch(/record_event/)
    const started=performance.now(), health=await fetch(base+'/api/health'), healthMs=performance.now()-started
    const beforeRelease=!existsSync(released), pendingAtHealth=!complete
    const response=await pending
    expect(response.headers.get('content-type')).toBe(warm.headers.get('content-type'))
    expect(await response.text()).toBe(expected)
    process.stdout.write('M1 native HTTP observation '+JSON.stringify({ appPid: info!.pid, nativePid: entries[0].pid, sql: entries[0].sql, healthMs, beforeRelease, pendingAtHealth, healthStatus: health.status, bodySha256:createHash('sha256').update(expected).digest('hex') })+'\n')
    expect(health.status).toBe(200)
    expect(healthMs).toBeLessThan(300)
    expect(beforeRelease).toBe(true)
    expect(pendingAtHealth).toBe(true)
    expect(entries[0].pid).not.toBe(info!.pid)
    // Acknowledged API commits become visible on the retained child connection.
    const another={...request,idempotencyKey:'m1-next',sourceIdentity:'synthetic/m1-next',payload:{announcement:{...request.payload.announcement,records:[{...request.payload.announcement.records[0]!,enterprise:{name:'另一合成M1企业'}}]}}}
    const commit=async(body:unknown)=> (await fetch(`${info!.imports}/api/roster/import/commit`,{method:'POST',headers:{authorization:'Bearer synthetic-m1','content-type':'application/json'},body:JSON.stringify(body)})).json()
    expect((await commit(another)).status).toBe('committed')
    for(let n=0;n<3;n++)expect(await (await fetch(base+'/api/roster/recognitions')).json()).toMatchObject({counts:{titlePairs:2,enterprises:2},rows:[{name:'另一合成M1企业'},{name:'合成M1企业'}]})
    const failed={...another,idempotencyKey:'m1-rollback',sourceIdentity:'synthetic/m1-rollback',payload:{announcement:{...another.payload.announcement,records:[{...another.payload.announcement.records[0]!,enterprise:{name:'不得部分提交合成企业'}},{...another.payload.announcement.records[0]!,enterprise:{name:'非法称号合成企业'},titleCode:'invalid'}]}}}
    expect((await commit(failed)).status).toBe('failed')
    const afterRollback=await (await fetch(base+'/api/roster/recognitions?pageSize=999')).json()
    expect(afterRollback).toMatchObject({pageSize:200,counts:{titlePairs:2,enterprises:2},rows:[{name:'另一合成M1企业'},{name:'合成M1企业'}]})
    expect(afterRollback.rows).toHaveLength(2)
    // No reader substitution: a real native busy error must return once, before
    // the independent lock release, rather than replaying on the original owner.
    if(holder.exitCode===null)await once(holder,'exit')
    writeFileSync(marker,'')
    rmSync(released,{force:true})
    const busy=spawn(process.execPath,['-e',`const D=require(${JSON.stringify(driver)}),fs=require('node:fs'),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();fs.writeFileSync(${JSON.stringify(released)},'released')},5800);`],{stdio:['ignore','pipe','pipe']})
    children.push(busy);await once(busy.stdout!,'data')
    const failure=await fetch(base+'/api/roster/recognitions')
    expect(failure.status).toBe(500)
    expect(await failure.json()).toMatchObject({statusCode:500})
    expect(existsSync(released)).toBe(false)
    const failedEntries=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    expect(failedEntries).toHaveLength(1);expect(failedEntries[0].pid).not.toBe(info!.pid)
    if(busy.exitCode===null)await once(busy,'exit')
    writeFileSync(marker,'');writeFileSync(fault,'exit before native invocation')
    const recovered=await fetch(base+'/api/roster/recognitions?pageSize=999')
    expect(recovered.status).toBe(200);expect(await recovered.json()).toEqual(afterRollback)
    const recoveryEntries=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    const mainEntries=recoveryEntries.filter(x=>x.pid===info!.pid)
    expect(mainEntries).toHaveLength(3) // two award scans plus selected evidence
    expect(mainEntries.filter(x=>x.sql.includes('where "record_event"."event_type" = ? order by'))).toHaveLength(1)
    expect(recoveryEntries.filter(x=>x.pid!==info!.pid)).toHaveLength(1)
    rmSync(fault)
    const restarted=await fetch(base+'/api/roster/recognitions?pageSize=999')
    expect(await restarted.json()).toEqual(afterRollback)
    writeFileSync(marker,'')
    const cancelLock=spawn(process.execPath,['-e',`const D=require(${JSON.stringify(driver)}),db=new D(${JSON.stringify(join(dir,'fixture.db'))});db.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close()},800)`],{stdio:['ignore','pipe','pipe']})
    children.push(cancelLock);await once(cancelLock.stdout!,'data')
    const controller=new AbortController()
    const cancelled=fetch(base+'/api/roster/recognitions',{signal:controller.signal}).then(()=>null,error=>error)
    for(let i=0;i<200&&!readFileSync(marker,'utf8');i++)await pause(2)
    const activePid=JSON.parse(readFileSync(marker,'utf8').trim().split('\n')[0]!).pid
    const enterprise=fetch(base+'/api/roster/enterprises')
    controller.abort();expect((await cancelled)?.name).toBe('AbortError')
    const enterpriseResponse=await enterprise
    expect(enterpriseResponse.status).toBe(200)
    expect(await enterpriseResponse.json()).toMatchObject({counts:{total:2},rows:[{name:'另一合成M1企业'},{name:'合成M1企业'}]})
    const afterCancel=readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x))
    expect(afterCancel.every(x=>x.pid===activePid)).toBe(true)
  } finally {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') }
    const nativePids=existsSync(marker)?[...new Set(readFileSync(marker,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).pid))]:[]
    rmSync(dir,{recursive:true,force:true})
    const remaining=[...children.map(x=>x.pid),...nativePids].filter(pid=>{if(!pid)return false;try{process.kill(pid,0);return true}catch{return false}})
    process.stdout.write('M1 owned HTTP cleanup '+JSON.stringify({dir,pids:children.map(x=>x.pid),nativePids,remaining,removed:!existsSync(dir)})+'\n')
    expect(remaining).toEqual([]);expect(existsSync(dir)).toBe(false)
  }
}, 20000)
