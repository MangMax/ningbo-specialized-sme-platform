import { createRequire } from 'node:module'
import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

// Actual CLI with a synthetic SQLite/HTTP/IPC carrier; no business or performance qualification.
// Native partial/stop faults use the real helper. Forged/unknown receipt cases are consumer simulations.
let owner: string
const owners = ['bench-correspondence-http.mjs', 'bench-record-comparison-http.mjs']
function run(fault: string) {
 const root = mkdtempSync(join(tmpdir(), 'd5-test-'))
 const events = join(root, 'events'), db = join(root, 'input.sqlite')
 let database: any, recovered = false, primary: unknown
 try {
 const Database = createRequire(import.meta.url)('better-sqlite3'); database = new Database(db); database.exec("create table platform_query(id integer);insert into platform_query values(1);create table source_document(id integer,source text);insert into source_document values(1,'jxj');create table enterprise(id integer);insert into enterprise values(1);"); database.close(); const originalInput = readFileSync(db)
 writeFileSync(join(root, 'server.mjs'), `import http from 'node:http';
 const f=process.env.D5_FAULT;
 process.on('message',m=>process.send(m==='reset'?'reset':{heap:100,rss:200,heapStart:50,baseHeap:50,combinedHeap:100,combinedHeapStart:50,workerHeap:0,maxRss:200,heapLimit:1000,lagP95Ms:1,lagMaxMs:1,lagSamples:1}));
 if(f==='partial-exited'){const {spawn}=await import('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setTimeout(()=>process.exit(3),50);}
 http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
 if(f==='headers'&&req.url!=='/api/health')return;
 res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
 if((f==='body'&&req.url!=='/api/health')||(f==='healthbody'&&req.url==='/api/health')){res.flushHeaders();res.write(' ');return;}
 const value={rows:[],counts:{}};const body=req.url==='/mcp'?{result:{content:[{text:JSON.stringify(value)}]}}:value;
 res.end(f.includes('primary')&&req.url!=='/api/health'?'INVALID_JSON':JSON.stringify(body));
 if(req.url!=='/api/health')process.send({heap:100,rss:200,baseHeap:50,maxRss:200,heapLimit:1000,lagP95Ms:1,lagMaxMs:1});
 });}).listen(Number(process.env.PORT),'127.0.0.1');`)
 const helper = new URL('../scripts/lib/isolated-local-services.mjs', import.meta.url).href
 writeFileSync(join(root, 'fs.mjs'), `export * from 'node:fs';import * as fs from 'node:fs';
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');
 export function mkdtempSync(...a){if(process.env.D5_FAULT==='temp')throw Error('TEMP_FAILURE');const d=fs.mkdtempSync(...a);process.env.D5_RUNTIME=d;log({type:'root',path:d});return d;}
 export function writeFileSync(...a){if(process.env.D5_FAULT==='write')throw Error('WRITE_FAILURE');return fs.writeFileSync(...a);}
 export function rmSync(...a){log({type:'remove',path:a[0]});if(process.env.D5_FAULT.includes('root'))throw Error('ROOT_FAILURE');return fs.rmSync(...a);}`)
 writeFileSync(join(root, 'helper.mjs'), `export * from ${JSON.stringify(helper)};import * as h from ${JSON.stringify(helper)};import fs from 'node:fs';
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');const f=process.env.D5_FAULT;
 export async function reserveLoopbackPort(){if(f==='reserve')throw Error('RESERVE_FAILURE');return h.reserveLoopbackPort();}
 export function forkOwnedChild(entry,args,options){if(f==='fork')throw Error('FORK_FAILURE');if(f.startsWith('forged-')){const e=Error('UNAUTHENTICATED_START');e.startResult={brand:'isolated-local-services.start',version:f==='forged-version'?9:1,acquisition:'partial',termination:'confirmed',groupId:123};throw f==='forged-clone'?structuredClone(e):e;}try{return h.forkOwnedChild(process.env.D5_SERVER,[],{...options,execArgv:[]});}catch(e){
 globalThis.originalStartError=e;const r=h.getOwnedChildStartFailure(e);
 if(r)log({type:'authentication',original:true,causeSame:r.cause===e.cause,childSame:r.child===globalThis.nativeChild,cloneRejected:h.getOwnedChildStartFailure(structuredClone(e))===undefined,forgedRejected:h.getOwnedChildStartFailure({startResult:e.startResult})===undefined,versionRejected:h.getOwnedChildStartFailure({startResult:{...e.startResult,version:9}})===undefined});
 throw e;
 }}
 export async function stopOwnedChild(c){log({type:'stop',pid:c.pid,sameChild:c===globalThis.nativeChild});if(f==='partial-exited')await new Promise(r=>setTimeout(r,150));
 if(['unknown','version','absent'].includes(f)){const e=Error('UNKNOWN_STOP');if(f!=='absent')e.stopResult={brand:f==='unknown'?'other':'isolated-local-services.stop',version:f==='unknown'?1:9,termination:'confirmed'};throw e;}
 const kill=process.kill;let terms=0;
 process.kill=function(pid,sig){log({type:'signal',pid,signal:sig,actor:'helper'});if(f==='permanent'||(f==='finite-three'&&sig==='SIGTERM'&&terms++<3))throw Object.assign(Error('SIGNAL_FAILURE'),{code:'EPERM'});return kill(pid,sig);};
 try{await h.stopOwnedChild(c);}catch(e){log({type:'stop-receipt',receipt:e.stopResult});throw e;}finally{process.kill=kill;}
 if(f.includes('stoperror')){const e=Error('STOP_FAILURE');e.stopResult={brand:'isolated-local-services.stop',version:1,termination:'confirmed'};throw e;}
 log({type:'stopped'});
 }`)
 writeFileSync(join(root,'native.mjs'), `export * from 'node:child_process';import * as cp from 'node:child_process';import fs from 'node:fs';
 const f=process.env.D5_FAULT;let observations=0;
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');
 export function fork(entry,args,options){const c=cp.fork(entry,args,{...options,stdio:['pipe','pipe','pipe','ipc','pipe']});globalThis.nativeChild=c;log({type:'child',pid:c.pid,port:Number(options.env.PORT)});
 if(f==='partial-events')setImmediate(()=>{for(let i=0;i<40;i++)c.emit('error',Error('ASYNC_NATIVE_'+i));});
 for(const [i,stream] of c.stdio.entries())if(stream?.destroy){const destroy=stream.destroy;stream.destroy=function(...a){log({type:'release-stream',index:i});const r=destroy.apply(this,a);if(f==='partial-release')throw Error('PIPE_RELEASE_'+i);return r;};}
 const disconnect=c.disconnect;c.disconnect=function(){log({type:'release-ipc'});const r=disconnect.call(this);if(f==='partial-native-event')c.send({afterDisconnect:true});if(f==='partial-release')throw Error('IPC_RELEASE');return r;};
 const unref=c.unref;c.unref=function(){log({type:'release-unref'});return unref.call(this);};
 return c;}
 export function execFileSync(cmd,args,options){if(cmd==='ps'&&(f.startsWith('partial-')||f.includes('native-stop'))){observations++;log({type:'observe',timeout:options.timeout});if((f.includes('native-stop')?observations===2:observations===1)||['partial-permanent','partial-release'].includes(f)){
 if(f==='partial-timeout')return cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},5000)'],options);
 if(f==='partial-exited')cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},350)']);
 throw Object.assign(Error('POSTFORK_PS_EIO'),{code:'EIO'});}}return cp.execFileSync(cmd,args,options);}`)
 writeFileSync(join(root, 'hook.mjs'), `import {registerHooks} from 'node:module';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
 process.on('uncaughtExceptionMonitor',e=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify({type:'terminal-error',primarySame:e.cause===globalThis.originalStartError})+'\\n'));
 const print=console.log;console.log=(...a)=>{fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify({type:'success',rootExists:fs.existsSync(process.env.D5_RUNTIME)})+'\\n');print(...a)};
 registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===pathToFileURL(process.env.D5_OWNER).href){let s=String(r.source).replace("from 'node:fs'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'fs.mjs'))}).href)).replace("from './lib/isolated-local-services.mjs'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'helper.mjs'))}).href));return {...r,source:s};}if(url.endsWith('/better-sqlite3/lib/index.js'))return {...r,source:String(r.source)+${JSON.stringify("\nconst D=module.exports, close=D.prototype.close, prepare=D.prototype.prepare;D.prototype.close=function(){const r=close.call(this);require('node:fs').appendFileSync(process.env.D5_EVENTS,JSON.stringify({type:'db-close'})+'\\n');if(process.env.D5_FAULT.includes('db-close'))throw Error('DB_CLOSE_FAILURE');return r};D.prototype.prepare=function(...a){if(process.env.D5_FAULT.includes('db-read'))throw Error('DB_READ_FAILURE');return prepare.apply(this,a)};")}};if(url===${JSON.stringify(helper)})return {...r,source:String(r.source).replace("from 'node:child_process'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'native.mjs'))}).href))};return r;}});`)
 const started=Date.now()
 const result=spawnSync(process.execPath,['--import',join(root,'hook.mjs'),owner,fault==='db-open'?db+'.missing':db,'http',owner.includes('correspondence')?'list':'comparison'],{encoding:'utf8',timeout:24000,env:{...process.env,PERF_BENCHMARK_LANE:'legacy',D5_FAULT:fault,D5_OWNER:owner,D5_SERVER:join(root,'server.mjs'),D5_EVENTS:events}})
 const journal=existsSync(events)?readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[]
 const runtime=journal.find(e=>e.type==='root')?.path, pid=journal.find(e=>e.type==='child')?.pid
 const retained=runtime?existsSync(runtime):false
 let alive=false
 if(pid)try{process.kill(pid,0);alive=true}catch{}
 const table=execFileSync('ps',['-A','-o','pid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number))
 const groupAlive=!!pid && table.some(([,group])=>group===pid)
 const port=journal.find(e=>e.type==='child')?.port
 const listener=port?spawnSync(process.execPath,['-e',`const n=require('node:net').connect(${port},'127.0.0.1');n.on('connect',()=>process.exit(0));n.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),500)`],{timeout:1000}).status===0:false
 const beforeHarness={retained,alive,groupAlive,listener}
 if(process.env.D5_EVIDENCE_DIR)writeFileSync(join(process.env.D5_EVIDENCE_DIR,`fault-${owner.split('/').at(-1)}-${fault}.json`),JSON.stringify({fault,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr,journal,beforeHarness,elapsed:Date.now()-started},null,2))
 // Recovery is explicitly a different actor, after observations/assertion inputs were frozen.
 if(groupAlive)try{process.kill(-pid,'SIGKILL')}catch{}
 if(runtime)rmSync(runtime,{recursive:true,force:true})
 const afterTable=execFileSync('ps',['-A','-o','pid=,pgid='],{encoding:'utf8'})
 if(process.env.D5_EVIDENCE_DIR)writeFileSync(join(process.env.D5_EVIDENCE_DIR,`recovery-${owner.split('/').at(-1)}-${fault}.json`),JSON.stringify({actor:'harness-only',pid,runtime,rootAbsent:!runtime||!existsSync(runtime),ps:afterTable},null,2))
 const input=readFileSync(db).equals(originalInput);rmSync(root,{recursive:true,force:true}); recovered=true
 return {...result,journal,beforeHarness,input,elapsed:Date.now()-started}
 } catch (error) { primary=error; throw error }
 finally {
  if (!recovered) {
   // Harness-only recovery also owns setup/observation failures; never candidate credit.
   const failures: unknown[] = []
   const attempt = (cleanup: () => void) => { try { cleanup() } catch (error) { failures.push(error) } }
   if (database?.open) attempt(() => database.close())
   let recoveryJournal: any[] = []
   attempt(() => {
    if (existsSync(events)) for (const line of readFileSync(events,'utf8').split('\n').filter(Boolean)) {
     try { recoveryJournal.push(JSON.parse(line)) } catch (error) { failures.push(error) }
    }
   })
   const childPid = recoveryJournal.find(event => event.type==='child')?.pid
   const runtimeRoot = recoveryJournal.find(event => event.type==='root')?.path
   if (childPid) attempt(() => { try { process.kill(-childPid,'SIGKILL') } catch (error: any) { if (error.code!=='ESRCH') throw error } })
   if (runtimeRoot) attempt(() => rmSync(runtimeRoot,{recursive:true,force:true}))
   attempt(() => rmSync(root,{recursive:true,force:true}))
   if (failures.length) throw new AggregateError(primary===undefined ? failures : [primary,...failures], 'Lifecycle fixture recovery failed', {cause:primary})
  }
 }
}

for (const name of owners) {
 for (const fault of ['normal','headers','body','healthbody','temp','write','reserve','fork','root','stoperror','primary-stoperror-root','partial-eio','partial-timeout','partial-permanent','partial-exited','partial-release','partial-native-event','forged-start','forged-clone','forged-version','unknown','version','absent','native-stop','primary-native-stop-root',...(name.includes('comparison')?['db-open','db-read','db-close','db-read-db-close']:[])]) it(`${name} lifecycle ${fault}`,()=>{
  owner=fileURLToPath(new URL('../scripts/'+name,import.meta.url))
  const r=run(fault)
  expect(r.error,r.stderr).toBeUndefined();expect(r.status,r.stderr).toBe(fault==='normal'?0:1);expect(r.input).toBe(true)
  if(fault==='normal'){expect(r.stdout.trim().split('\n')).toHaveLength(1);expect(r.journal.at(-1)).toEqual({type:'success',rootExists:false})}
  else expect(r.stdout).toBe('')
  const unknown=['fork','partial-permanent','partial-exited','partial-release','forged-start','forged-clone','forged-version','unknown','version','absent'].includes(fault)
  expect(r.beforeHarness.retained).toBe(unknown||fault.includes('root'))
  const child=r.journal.some(e=>e.type==='child')
  expect(r.journal.filter(e=>e.type==='stop')).toHaveLength(child?1:0)
  if(unknown){expect(r.stderr).toContain('UNCONFIRMED');expect(r.journal.some(e=>e.type==='remove')).toBe(false)}
  if(child)expect(r.journal.find(e=>e.type==='stop').sameChild).toBe(true)
  if(fault.startsWith('partial-')){
   expect(r.journal.find(e=>e.type==='terminal-error').primarySame).toBe(true)
   expect(r.journal.find(e=>e.type==='observe').timeout).toBe(250)
   expect(r.journal.find(e=>e.type==='authentication')).toEqual({type:'authentication',original:true,causeSame:true,childSame:true,cloneRejected:true,forgedRejected:true,versionRejected:true})
   expect(r.stderr).toMatch(fault==='partial-timeout'?/ETIMEDOUT/:/POSTFORK_PS_EIO/)
   if(unknown){expect(r.journal.filter(e=>e.type==='signal')).toHaveLength(0);expect(r.beforeHarness.groupAlive).toBe(true)}
  }
  if(!unknown&&!fault.includes('root'))expect(r.beforeHarness).toEqual({retained:false,alive:false,groupAlive:false,listener:false})
  if(fault.includes('native-stop')){expect(r.journal.find(e=>e.type==='stop-receipt').receipt).toMatchObject({brand:'isolated-local-services.stop',version:1,termination:'confirmed',finalMembers:[]})}
  if(fault.includes('db-')){expect(r.journal.filter(e=>e.type==='db-close')).toHaveLength(fault==='db-open'?0:1);if(fault.includes('db-read'))expect(r.stderr).toContain('DB_READ_FAILURE');if(fault.includes('db-close'))expect(r.stderr).toContain('DB_CLOSE_FAILURE')}
  if(fault==='partial-release'){for(const index of [0,1,2,4])expect(r.journal.some(e=>e.type==='release-stream'&&e.index===index)).toBe(true);for(const reason of ['PIPE_RELEASE_0','PIPE_RELEASE_1','PIPE_RELEASE_2','PIPE_RELEASE_4','IPC_RELEASE'])expect(r.stderr).toContain(reason)}
  if(['headers','body','healthbody'].includes(fault))expect(r.stderr).toContain('deadline exceeded')
  if(fault==='partial-native-event')expect(r.stderr).toContain('ERR_IPC_CHANNEL_CLOSED')
  if(fault==='primary-stoperror-root'){expect(r.stderr).toContain('INVALID_JSON');expect(r.stderr).toContain('STOP_FAILURE');expect(r.stderr).toContain('ROOT_FAILURE')}
 },30000)
}
