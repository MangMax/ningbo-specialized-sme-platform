import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

// Each fault runs in its own Node runtime; only OS boundaries are intercepted.
// The oracle uses the original ps and kill, before any harness recovery.
async function nativeCase(body: string) {
  const code = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import timers from 'node:timers/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {once} from 'node:events';
    import {spawnOwnedChild,stopOwnedChild,startIsolatedNuxt} from ${JSON.stringify(new URL('../scripts/lib/isolated-local-services.mjs', import.meta.url).href)};
    const realKill=process.kill.bind(process), realPs=cp.execFileSync, realSleep=timers.setTimeout;
    const table=()=>realPs('ps',['-A','-o','pid=,pgid=,lstart='],{encoding:'utf8'});
    const live=p=>{try{realKill(p,0);return true}catch{return false}};
    const children=[]; const errors=[]; const signals=[]; const observations=[];
    const fault=(code)=>{const e=Object.assign(new Error('injected '+code),{code,cause:new Error('original cause')});errors.push(e);return e};
    const start=async()=>{const c=spawnOwnedChild(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});children.push(c);await once(c,'message');return c};
    const capture=async(c)=>{try{const value=await stopOwnedChild(c);return {value}}catch(error){return {error}}};
    const check=(error,termination)=>{assert(error instanceof AggregateError);assert.equal(error.stopResult.brand,'isolated-local-services.stop');assert.equal(error.stopResult.version,1);assert.equal(error.stopResult.termination,termination);assert.deepEqual(error.errors,errors);assert.deepEqual(error.stopResult.failures.map(f=>f.error),errors);for(let i=0;i<errors.length;i++){assert.equal(error.errors[i],errors[i]);assert.equal(error.errors[i].cause,errors[i].cause);assert(error.stopResult.failures[i].phase)}};
    const absent=c=>!table().split('\\n').some(l=>Number(l.trim().split(/\\s+/)[1])===c.pid);
    try { ${body} }
    finally { process.kill=realKill;cp.execFileSync=realPs;timers.setTimeout=realSleep;syncBuiltinESMExports(); for(const c of children){try{realKill(-c.pid,'SIGKILL')}catch{} } await realSleep(100); }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const result = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  expect({ code: result, output: output.replace('Local: http://127.0.0.1:1/\n', '') }).toEqual({ code: 0, output: '' })
}

it('cleans a real group after pre-TERM EIO and still rejects the original error', async () => {
  await nativeCase(`
    const child=await start(), unrelated=await start();
    process.kill=(pid,sig)=>{if(pid===-child.pid){signals.push(sig);if(sig==='SIGTERM')throw fault('EIO')}return realKill(pid,sig)};
    const {error}=await capture(child);
    assert(absent(child),'candidate must remove group before harness recovery');assert(live(unrelated.pid));
    check(error,'confirmed');assert.equal(error.stopResult.reason,'group-absent');assert(signals.includes('SIGKILL'));
    assert(errors.length>=1);assert(errors.length<=3);
  `)
}, 12000)

it('retains a single pre-TERM error after a successful retry', async () => {
  await nativeCase(`
    const child=await start();let count=0;
    process.kill=(pid,sig)=>{if(pid===-child.pid&&sig==='SIGTERM'&&count++===0)throw fault('EIO');return realKill(pid,sig)};
    const {error}=await capture(child);check(error,'confirmed');assert.equal(errors.length,1);assert(absent(child));
    assert.equal(error.stopResult.failures[0].phase,'SIGTERM');
  `)
}, 12000)

it('keeps post-signal errors while final observation proves termination', async () => {
  await nativeCase(`
    const child=await start();
    process.kill=(pid,sig)=>{const result=realKill(pid,sig);if(pid===-child.pid&&sig==='SIGKILL')throw fault('EIO');return result};
    const {error}=await capture(child);check(error,'confirmed');assert.equal(errors.length,1);assert(absent(child));
    assert.equal(error.stopResult.failures[0].phase,'SIGKILL');
  `)
}, 12000)

it('recovers transient ps and wait failures without losing their causes or signal authority', async () => {
  await nativeCase(`
    const child=await start();let psCount=0, sleepCount=0, fresh=false;
    cp.execFileSync=(...args)=>{assert(args[2].timeout>0&&args[2].timeout<=250);psCount++;if(psCount===1||psCount===4){fresh=false;throw fault('EIO')}const value=realPs(...args);fresh=true;return value};
    timers.setTimeout=(...args)=>{if(sleepCount++===1)return Promise.reject(fault('WAIT'));return realSleep(...args)};
    syncBuiltinESMExports();
    process.kill=(pid,sig)=>{if(pid===-child.pid){assert(fresh);fresh=false;signals.push(sig)}return realKill(pid,sig)};
    const {error}=await capture(child);check(error,'confirmed');assert(absent(child));assert(signals.includes('SIGKILL'));
    assert.deepEqual(errors.map(e=>e.code),['EIO','WAIT','EIO']);
  `)
}, 12000)

it('preserves ordered TERM KILL and final ps errors after real KILL', async () => {
  await nativeCase(`
    const child=await start();let afterKill=false, psFailed=false;
    process.kill=(pid,sig)=>{if(pid===-child.pid){signals.push(sig);if(sig==='SIGTERM')throw fault('TERM');const value=realKill(pid,sig);afterKill=true;throw fault('KILL')}return realKill(pid,sig)};
    cp.execFileSync=(...args)=>{if(afterKill&&!psFailed){psFailed=true;throw fault('PS')}return realPs(...args)};syncBuiltinESMExports();
    const {error}=await capture(child);check(error,'confirmed');assert(absent(child));
    assert.deepEqual(errors.map(e=>e.code),['TERM','TERM','TERM','KILL','PS']);
    assert.deepEqual(error.stopResult.failures.map(f=>f.phase),['SIGTERM','SIGTERM','SIGTERM','SIGKILL','KILL-wait-observe']);
  `)
}, 12000)

it('reports permanent denial as unconfirmed and retains the handle for recovery', async () => {
  await nativeCase(`
    const child=await start(), unrelated=await start();
    process.kill=(pid,sig)=>{if(pid===-child.pid){signals.push(sig);throw fault('EPERM')}return realKill(pid,sig)};
    const began=Date.now();const {error}=await capture(child);assert(Date.now()-began<6000);
    assert(error instanceof AggregateError);assert.equal(error.stopResult.termination,'unconfirmed');assert.equal(error.stopResult.reason,'members-remain');
    assert.deepEqual(signals,['SIGTERM','SIGTERM','SIGTERM','SIGKILL']);
    assert.deepEqual(error.errors.slice(0,4),errors);assert.equal(error.stopResult.failures.at(-1).phase,'final-verification');
    assert(live(child.pid));assert(live(unrelated.pid));
    process.kill=realKill;assert.equal(await stopOwnedChild(child),undefined);assert(absent(child));assert(live(unrelated.pid));
  `)
}, 12000)

it('never signals during permanent observation failure and reports unknown final membership', async () => {
  await nativeCase(`
    const child=await start();
    cp.execFileSync=()=>{throw fault('ETIMEDOUT')};syncBuiltinESMExports();
    process.kill=(pid,sig)=>{if(pid===-child.pid)signals.push(sig);return realKill(pid,sig)};
    const began=Date.now();const {error}=await capture(child);assert(Date.now()-began<6000);
    assert.equal(error.stopResult.termination,'unconfirmed');assert.equal(error.stopResult.reason,'observation-failed');assert.equal(error.stopResult.finalMembers,null);
    assert.deepEqual(signals,[]);assert(live(child.pid));assert.deepEqual(error.errors.slice(0,-1),errors);
    cp.execFileSync=realPs;syncBuiltinESMExports();assert.equal(await stopOwnedChild(child),undefined);assert(absent(child));
  `)
}, 12000)

it('keeps unowned live children safe and preserves undefined no-op results', async () => {
  await nativeCase(`
    const child=cp.spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);await once(child,'message');
    const {error}=await capture(child);assert(error instanceof AggregateError);assert.match(error.errors[0].message,/Use spawnOwnedChild or forkOwnedChild/);assert.equal(error.stopResult,undefined);assert(live(child.pid));
    const exit=once(child,'exit');realKill(-child.pid,'SIGKILL');await exit;assert.equal(await stopOwnedChild(child),undefined);
    const owned=await start();process.kill=realKill;assert.equal(await stopOwnedChild(owned),undefined);assert(absent(owned));assert.equal(await stopOwnedChild(owned),undefined);
  `)
}, 12000)

it('fake identity replacement confirms only retirement of the original identity without signalling the new group', async () => {
  await nativeCase(`
    const child=await start();let replaced=false;
    process.kill=(pid,sig)=>{if(pid===-child.pid){signals.push(sig);replaced=true;throw fault('EIO')}return realKill(pid,sig)};
    cp.execFileSync=(...args)=>{const raw=realPs(...args);return replaced?raw.split('\\n').map(l=>Number(l.trim().split(/\\s+/)[0])===child.pid?l+' REPLACED':l).join('\\n'):raw};syncBuiltinESMExports();
    const {error}=await capture(child);check(error,'confirmed');assert.equal(error.stopResult.reason,'identity-replaced');assert.deepEqual(signals,['SIGTERM']);assert(live(child.pid));
    // This lane fakes ps identity, so the real child deliberately remains for harness recovery.
  `)
}, 12000)

it('fake unknown exited identity forbids signals and retains an unconfirmed receipt', async () => {
  await nativeCase(`
    let starting=true, group;
    cp.execFileSync=(...args)=>starting?'':String(group)+' '+String(group)+' UNKNOWN';syncBuiltinESMExports();
    const child=await start();group=child.pid;starting=false;
    const exit=once(child,'exit');realKill(-child.pid,'SIGKILL');await exit;
    process.kill=(pid,sig)=>{signals.push(sig);return realKill(pid,sig)};
    const {error}=await capture(child);assert.equal(error.stopResult.termination,'unconfirmed');assert.equal(error.stopResult.reason,'identity-unverified');assert.deepEqual(signals,[]);
    assert(error.errors.slice(0,-1).every(e=>e.message==='Cannot verify exited service group identity'));
  `)
}, 12000)

it('retains startup primary and confirmed cleanup failure in the public startup wrapper using a fake startup', async () => {
  await nativeCase(`
    const realSpawn=cp.spawn;
    cp.spawn=(command,args,options)=>{assert(args[0].endsWith('/nuxt.mjs'));const child=realSpawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('Local: http://127.0.0.1:1/');setInterval(()=>{},1000)"],options);children.push(child);return child};syncBuiltinESMExports();
    process.kill=(pid,sig)=>{if(children.some(c=>pid===-c.pid)&&sig==='SIGTERM')throw fault('EIO');return realKill(pid,sig)};
    let combined;try{await startIsolatedNuxt({cwd:process.cwd()})}catch(e){combined=e}
    assert(combined instanceof AggregateError);assert.match(combined.errors[0].message,/Spawned Nuxt announced/);assert.equal(combined.cause,combined.errors[0]);
    check(combined.errors[1],'confirmed');assert.equal(combined.stopResult,combined.errors[1].stopResult);assert(absent(children[0]));
  `)
}, 12000)

it('retains a real synchronous observation timeout then recovers within the stop budget', async () => {
  await nativeCase(`
    const child=await start();let first=true;
    cp.execFileSync=(...args)=>{if(first){first=false;try{return realPs(process.execPath,['-e','setTimeout(()=>process.exit(0),750)'],args[2])}catch(e){errors.push(e);throw e}}return realPs(...args)};syncBuiltinESMExports();
    const began=Date.now();const {error}=await capture(child);check(error,'confirmed');assert(absent(child));assert.equal(errors[0].code,'ETIMEDOUT');assert(Date.now()-began<5500);
  `)
}, 12000)

it('retains final observation errors even when the real group has already disappeared', async () => {
  await nativeCase(`
    const child=await start();let gone=false, injected=false;
    cp.execFileSync=(...args)=>{if(gone&&!injected){injected=true;throw fault('FINAL')}const raw=realPs(...args);if(!raw.split('\\n').some(l=>Number(l.trim().split(/\\s+/)[1])===child.pid))gone=true;return raw};syncBuiltinESMExports();
    const {error}=await capture(child);check(error,'confirmed');assert(absent(child));assert.equal(errors.length,1);assert.equal(error.stopResult.failures[0].phase,'final-observe');
  `)
}, 12000)
