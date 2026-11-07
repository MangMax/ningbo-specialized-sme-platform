import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

// Actual owner CLI; only authorized native boundaries are instrumented. No external fixtures.
const owner = fileURLToPath(new URL('../scripts/bench-platform-query-http.mjs', import.meta.url))
function run(fault: string) {
 const root = mkdtempSync(join(tmpdir(), 'd5-test-'))
 const events = join(root, 'events'), db = join(root, 'input.sqlite')
 writeFileSync(db, 'untouched input')
 writeFileSync(join(root, 'server.mjs'), `import http from 'node:http';import fs from 'node:fs';
 const fault=process.env.D5_FAULT;
 process.on('message', m=>{if((fault==='begin'&&m.action==='begin')||(fault==='end'&&m.action==='end'))return;process.send({type:'performance-phase',id:m.id,result:{}})});
 if(fault==='early')process.exit(3);
 if(fault==='partial-exited'){const {spawn}=await import('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setTimeout(()=>process.exit(3),50);}
 http.createServer((req,res)=>{res.on('close',()=>{if(!res.writableEnded)fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify({type:'aborted',url:req.url})+'\\n')});
 if(fault==='ready'||(fault==='headers'&&req.url!=='/api/health'))return;
 res.writeHead(200,{'content-type':'application/json'});
 if((fault==='body'&&req.url!=='/api/health')||(fault==='healthbody'&&req.url==='/api/health')){res.flushHeaders();res.write(' ');return;}
 res.end(req.url==='/api/health'?'{}':JSON.stringify({rows:Array.from({length:fault.includes('primary')?0:25},()=>({relationsIncluded:false}))}));
 }).listen(Number(process.env.PORT),'127.0.0.1');`)
 const helper = new URL('../scripts/lib/isolated-local-services.mjs', import.meta.url).href
 const controller = new URL('../scripts/lib/performance-controller.mjs', import.meta.url).href
 writeFileSync(join(root, 'fs.mjs'), `export * from 'node:fs';import * as fs from 'node:fs';
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');
 export function mkdtempSync(...a){if(process.env.D5_FAULT==='temp')throw Error('TEMP_FAILURE');const d=fs.mkdtempSync(...a);process.env.D5_RUNTIME=d;log({type:'root',path:d});return d;}
 export function writeFileSync(...a){if(process.env.D5_FAULT==='write')throw Error('WRITE_FAILURE');return fs.writeFileSync(...a);}
 export function rmSync(...a){log({type:'remove',path:a[0]});if(process.env.D5_FAULT.includes('root'))throw Error('ROOT_FAILURE');return fs.rmSync(...a);}`)
 writeFileSync(join(root, 'helper.mjs'), `export * from ${JSON.stringify(helper)};import * as h from ${JSON.stringify(helper)};import fs from 'node:fs';
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');const f=process.env.D5_FAULT;
 export async function reserveLoopbackPort(){if(f==='reserve')throw Error('RESERVE_FAILURE');return h.reserveLoopbackPort();}
 export function forkOwnedChild(entry,args,options){if(f==='fork')throw Error('FORK_FAILURE');if(f.startsWith('forged-')){const e=Error('UNAUTHENTICATED_START');e.startResult={brand:'isolated-local-services.start',version:f==='forged-version'?9:1,acquisition:'partial',termination:'confirmed',groupId:123};throw f==='forged-clone'?structuredClone(e):e;}try{return h.forkOwnedChild(process.env.D5_SERVER,[],{...options,execArgv:[]});}catch(e){
 const r=h.getOwnedChildStartFailure(e);
 if(r)log({type:'authentication',original:true,cloneRejected:h.getOwnedChildStartFailure(structuredClone(e))===undefined,forgedRejected:h.getOwnedChildStartFailure({startResult:e.startResult})===undefined,versionRejected:h.getOwnedChildStartFailure({startResult:{...e.startResult,version:9}})===undefined});
 throw e;
 }}
 export async function stopOwnedChild(c){log({type:'stop',pid:c.pid});if(f==='partial-exited')await new Promise(r=>setTimeout(r,150));
 if(['unknown','version','absent'].includes(f)){const e=Error('UNKNOWN_STOP');if(f!=='absent')e.stopResult={brand:f==='unknown'?'other':'isolated-local-services.stop',version:f==='unknown'?1:9,termination:'confirmed'};throw e;}
 const kill=process.kill;let terms=0;
 process.kill=function(pid,sig){log({type:'signal',pid,signal:sig,actor:'helper'});if(f==='permanent'||(f==='finite-three'&&sig==='SIGTERM'&&terms++<3))throw Object.assign(Error('SIGNAL_FAILURE'),{code:'EPERM'});return kill(pid,sig);};
 try{await h.stopOwnedChild(c);}catch(e){log({type:'stop-receipt',receipt:e.stopResult});throw e;}finally{process.kill=kill;}
 if(f.includes('stoperror')){const e=Error('STOP_FAILURE');e.stopResult={brand:'isolated-local-services.stop',version:1,termination:'confirmed'};throw e;}
 log({type:'stopped'});
 }`)
 writeFileSync(join(root, 'controller.mjs'), `import {performanceController as real} from ${JSON.stringify(controller)};
 export function performanceController(c){if(process.env.D5_FAULT.startsWith('partial-'))throw Error('PARTIAL_MUST_NOT_CREATE_CONTROLLER');if(process.env.D5_FAULT==='controller')throw Error('CONTROLLER_FAILURE');const p=real(c);return {...p,close(){p.close();if(process.env.D5_FAULT==='close')throw Error('CLOSE_FAILURE');}};}`)
 writeFileSync(join(root,'native.mjs'), `export * from 'node:child_process';import * as cp from 'node:child_process';import fs from 'node:fs';
 const f=process.env.D5_FAULT;let observations=0;
 const log=x=>fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify(x)+'\\n');
 export function fork(entry,args,options){const c=cp.fork(entry,args,{...options,stdio:['pipe','pipe','pipe','ipc','pipe']});log({type:'child',pid:c.pid,port:Number(options.env.PORT)});
 if(f==='partial-events')setImmediate(()=>{for(let i=0;i<40;i++)c.emit('error',Error('ASYNC_NATIVE_'+i));});
 for(const [i,stream] of c.stdio.entries())if(stream?.destroy){const destroy=stream.destroy;stream.destroy=function(...a){log({type:'release-stream',index:i});const r=destroy.apply(this,a);if(f==='partial-release')throw Error('PIPE_RELEASE_'+i);return r;};}
 const disconnect=c.disconnect;c.disconnect=function(){log({type:'release-ipc'});const r=disconnect.call(this);if(f==='partial-native-event')c.send({afterDisconnect:true});if(f==='partial-release')throw Error('IPC_RELEASE');return r;};
 const unref=c.unref;c.unref=function(){log({type:'release-unref'});return unref.call(this);};
 return c;}
 export function execFileSync(cmd,args,options){if(cmd==='ps'&&f.startsWith('partial-')){observations++;log({type:'observe',timeout:options.timeout});if(observations===1||['partial-permanent','partial-release'].includes(f)){
 if(f==='partial-timeout')return cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},5000)'],options);
 if(f==='partial-exited')cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},350)']);
 throw Object.assign(Error('POSTFORK_PS_EIO'),{code:'EIO'});}}return cp.execFileSync(cmd,args,options);}`)
 writeFileSync(join(root, 'hook.mjs'), `import {registerHooks} from 'node:module';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
 const print=console.log;console.log=(...a)=>{fs.appendFileSync(process.env.D5_EVENTS,JSON.stringify({type:'success',rootExists:fs.existsSync(process.env.D5_RUNTIME)})+'\\n');print(...a)};
 registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===pathToFileURL(process.env.D5_OWNER).href){let s=String(r.source).replace("from 'node:fs'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'fs.mjs'))}).href)).replace("from './lib/isolated-local-services.mjs'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'helper.mjs'))}).href)).replace("from './lib/performance-controller.mjs'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'controller.mjs'))}).href));return {...r,source:s};}if(url.endsWith('/benchmark-authority.mjs'))return {...r,source:String(r.source).replace('export function readBenchmarkAuthority(', 'export function unusedAuthority(')+'\\nexport function readBenchmarkAuthority(){return {testOnly:true}}'};if(url===${JSON.stringify(helper)})return {...r,source:String(r.source).replace("from 'node:child_process'",'from '+JSON.stringify(pathToFileURL(${JSON.stringify(join(root,'native.mjs'))}).href))};return r;}});`)
 const started=Date.now()
 const result=spawnSync(process.execPath,['--import',join(root,'hook.mjs'),owner,db,'http','summary'],{encoding:'utf8',timeout:24000,env:{...process.env,PERF_BENCHMARK_LANE:'legacy',D5_FAULT:fault,D5_OWNER:owner,D5_SERVER:join(root,'server.mjs'),D5_EVENTS:events}})
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
 if(process.env.D5_EVIDENCE_DIR)writeFileSync(join(process.env.D5_EVIDENCE_DIR,`fault-${fault}.json`),JSON.stringify({fault,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr,journal,beforeHarness,elapsed:Date.now()-started},null,2))
 // Recovery is explicitly a different actor, after observations/assertion inputs were frozen.
 if(groupAlive)try{process.kill(-pid,'SIGKILL')}catch{}
 if(runtime)rmSync(runtime,{recursive:true,force:true})
 const afterTable=execFileSync('ps',['-A','-o','pid=,pgid='],{encoding:'utf8'})
 if(process.env.D5_EVIDENCE_DIR)writeFileSync(join(process.env.D5_EVIDENCE_DIR,`recovery-${fault}.json`),JSON.stringify({actor:'harness-only',pid,runtime,rootAbsent:!runtime||!existsSync(runtime),ps:afterTable},null,2))
 const input=readFileSync(db,'utf8');rmSync(root,{recursive:true,force:true})
 return {...result,journal,beforeHarness,input,elapsed:Date.now()-started}
}
it('emits success once only after stop and root removal',()=>{
 const r=run('normal');expect(r.status,r.stderr).toBe(0);expect(r.stdout.trim().split('\n')).toHaveLength(1)
 expect(r.journal.map(e=>e.type).filter(t=>!t.startsWith('release-'))).toEqual(['root','child','stop','signal','stopped','remove','success'])
 expect(r.journal.at(-1)).toEqual({type:'success',rootExists:false})
 expect(r.beforeHarness).toEqual({retained:false,alive:false,groupAlive:false,listener:false});expect(r.input).toBe('untouched input')
},30000)
for(const fault of ['temp','write','reserve','fork','controller','early','primary','close','root','stoperror','primary-stoperror-root','unknown','version','absent','finite-three','permanent','headers','body','ready','healthbody','begin','end'])it(`bounds ${fault} failure and preserves owned resource accountability`,()=>{
 const r=run(fault);expect(r.error,r.stderr).toBeUndefined();expect(r.status,r.stderr).toBe(1);expect(r.stdout).toBe('');expect(r.elapsed).toBeLessThan(23000)
 expect(r.input).toBe('untouched input');const child=r.journal.some(e=>e.type==='child');expect(r.journal.filter(e=>e.type==='stop')).toHaveLength(child?1:0)
 const retained=['fork','root','primary-stoperror-root','unknown','version','absent','permanent'].includes(fault)
 expect(r.beforeHarness.retained).toBe(retained);expect(r.beforeHarness.alive).toBe(['unknown','version','absent','permanent'].includes(fault));expect(r.beforeHarness.groupAlive).toBe(r.beforeHarness.alive);expect(r.beforeHarness.listener).toBe(r.beforeHarness.alive)
 if(fault==='primary-stoperror-root'){expect(r.stderr).toMatch(/0 !== 25/);expect(r.stderr).toMatch(/STOP_FAILURE/);expect(r.stderr).toMatch(/ROOT_FAILURE/);expect(r.stderr.indexOf('0 !== 25')).toBeLessThan(r.stderr.indexOf('STOP_FAILURE'));expect(r.stderr.indexOf('STOP_FAILURE')).toBeLessThan(r.stderr.indexOf('ROOT_FAILURE'))}
 if(fault==='finite-three'){expect(r.journal.filter(e=>e.type==='signal').map(e=>e.signal)).toEqual(['SIGTERM','SIGTERM','SIGTERM','SIGKILL']);expect(r.stderr).toMatch(/SIGNAL_FAILURE/);expect(r.journal.find(e=>e.type==='stop-receipt').receipt).toMatchObject({brand:'isolated-local-services.stop',version:1,termination:'confirmed',finalMembers:[]})}
 if(['headers','body','ready','healthbody'].includes(fault)){expect(r.journal.findIndex(e=>e.type==='aborted')).toBeGreaterThan(-1);expect(r.journal.findIndex(e=>e.type==='aborted')).toBeLessThan(r.journal.findIndex(e=>e.type==='signal'));expect(r.stderr).toMatch(/deadline exceeded/)}
 if(['begin','end'].includes(fault))expect(r.stderr).toMatch(/Telemetry phase timeout/)
 if(['unknown','version','absent','permanent'].includes(fault)){expect(r.stderr).toMatch(/UNCONFIRMED/);expect(r.journal.some(e=>e.type==='remove')).toBe(false)}
},30000)

for(const fault of ['partial-eio','partial-timeout','partial-permanent','partial-exited','partial-events','partial-release','partial-native-event'])it(`public native ${fault} retains startup cause and accountable terminal state`,()=>{
 const r=run(fault);expect(r.error,r.stderr).toBeUndefined();expect(r.status,r.stderr).toBe(1);expect(r.stdout).toBe('');expect(r.elapsed).toBeLessThan(23000)
 expect(r.stderr).toMatch(/Owned service startup failed/);expect(r.stderr).toMatch(fault==='partial-timeout'?/ETIMEDOUT/:/POSTFORK_PS_EIO/)
 expect(r.journal.filter(e=>e.type==='stop')).toHaveLength(1)
 expect(r.journal.find(e=>e.type==='observe').timeout).toBe(250)
 expect(r.stderr).not.toContain('PARTIAL_MUST_NOT_CREATE_CONTROLLER')
 expect(r.journal.find(e=>e.type==='authentication')).toEqual({type:'authentication',original:true,cloneRejected:true,forgedRejected:true,versionRejected:true})
 const unknown=['partial-permanent','partial-exited','partial-release'].includes(fault)
 expect(r.beforeHarness.retained).toBe(unknown);expect(r.beforeHarness.groupAlive).toBe(unknown)
 if(unknown){expect(r.stderr).toMatch(/UNCONFIRMED.*pid=.*root retained.*start=/);expect(r.journal.filter(e=>e.type==='signal')).toHaveLength(0);expect(r.journal.some(e=>e.type==='remove')).toBe(false)}
 else expect(r.beforeHarness).toEqual({retained:false,alive:false,groupAlive:false,listener:false})
 expect(r.input).toBe('untouched input')
 for(const index of [0,1,2,4])expect(r.journal.some(e=>e.type==='release-stream'&&e.index===index)).toBe(true)
 expect(r.journal.some(e=>e.type==='release-ipc')).toBe(true);expect(r.journal.some(e=>e.type==='release-unref')).toBe(true)
 if(fault==='partial-native-event')expect(r.stderr).toContain('ERR_IPC_CHANNEL_CLOSED')
 if(fault==='partial-events'){expect(r.stderr).toMatch(/ASYNC_NATIVE_0/);expect(r.stderr).toMatch(/droppedErrors=8/)}
 if(fault==='partial-release')for(const reason of ['PIPE_RELEASE_0','PIPE_RELEASE_1','PIPE_RELEASE_2','PIPE_RELEASE_4','IPC_RELEASE'])expect(r.stderr).toContain(reason)
},30000)

for(const fault of ['forged-start','forged-clone','forged-version'])it(`does not promote ${fault} to authenticated acquisition`,()=>{
 const r=run(fault);expect(r.error).toBeUndefined();expect(r.status).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toMatch(/UNAUTHENTICATED_START/);expect(r.stderr).toMatch(/UNCONFIRMED/)
 expect(r.journal.some(e=>['stop','signal','remove'].includes(e.type))).toBe(false);expect(r.beforeHarness.retained).toBe(true);expect(r.beforeHarness.groupAlive).toBe(false)
},30000)
