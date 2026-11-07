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
    import * as helper from ${JSON.stringify(new URL('../scripts/lib/isolated-local-services.mjs', import.meta.url).href)};
    const {spawnOwnedChild,forkOwnedChild,stopOwnedChild,startIsolatedNuxt,getOwnedChildStartFailure}=helper;
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
    finally { process.kill=realKill;cp.execFileSync=realPs;timers.setTimeout=realSleep;syncBuiltinESMExports(); const fs=await import('node:fs');
      const journal=phase=>{if(process.env.OWNED_TEST_JOURNAL)fs.appendFileSync(process.env.OWNED_TEST_JOURNAL,JSON.stringify({phase,pids:children.map(c=>c.pid),table:table()})+'\\n')};
      journal('before-harness');
      for(const c of children){if(c.pid)try{realKill(-c.pid,'SIGKILL')}catch{};if(c.connected)c.disconnect();for(const s of c.stdio??[])s?.destroy?.();c.unref()}
      await realSleep(150);journal('after-harness'); }
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
    cp.execFileSync=()=>'';syncBuiltinESMExports();
    let partial;try{await start()}catch(e){partial=e}
    const child=getOwnedChildStartFailure(partial).child;children.push(child);group=child.pid;
    cp.execFileSync=()=>String(group)+' '+String(group)+' UNKNOWN';syncBuiltinESMExports();
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


it.each(['spawn', 'fork'])('authenticates the original partial %s handle and preserves EIO after successful cleanup', async mode => {
  await nativeCase(`
    const fs=await import('node:fs'), os=await import('node:os'), path=await import('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-partial-'));
    try {
      const entry=path.join(dir,'timer.cjs');fs.writeFileSync(entry,'setInterval(()=>{},1000)');
      const unrelated=await start(); const realStart=cp.${mode};let native;
      cp.${mode}=(...args)=>{native=realStart(...args);children.push(native);return native};
      const original=fault('START_EIO');cp.execFileSync=()=>{throw original};syncBuiltinESMExports();
      let error;try{${mode === 'spawn' ? "spawnOwnedChild(process.execPath,[entry],{stdio:'pipe'})" : "forkOwnedChild(entry,{silent:true})"}}catch(e){error=e}
      assert(error);assert.equal(error.cause,original);
      const receipt=getOwnedChildStartFailure(error);assert.equal(receipt.child,native);assert.equal(receipt.cause,original);assert(Object.isFrozen(receipt));assert(Object.isFrozen(error.startResult));
      assert.deepEqual(error.startResult,{brand:'isolated-local-services.start',version:1,acquisition:'partial',termination:'unconfirmed',reason:'observation-failed',groupId:native.pid});
      for(const fake of [new Error(),{...error},Object.create(error),Object.assign(new Error(),{startResult:{...error.startResult,version:2}})])assert.equal(getOwnedChildStartFailure(fake),undefined);
      const asyncError=fault('ASYNC');native.emit('error',asyncError);assert.equal(receipt.errors[0],asyncError);assert(Object.isFrozen(receipt.errors));
      cp.execFileSync=realPs;syncBuiltinESMExports();
      const result=await capture(native);assert.equal(result.error.stopResult.termination,'confirmed');assert(result.error.errors.includes(asyncError));assert(absent(native));assert(live(unrelated.pid));assert.equal(error.cause,original);await realSleep(50);assert.equal(native.listenerCount('error'),0);
    } finally {fs.rmSync(dir,{recursive:true,force:true})}
  `)
}, 12000)


it.each(['spawn', 'fork'])('recovers partial %s after transient observation failure with undefined stop and strict cause', async mode => {
  await nativeCase(`
    const realStart=cp.${mode};let native;
    cp.${mode}=(...args)=>{native=realStart(...args);children.push(native);return native};
    const original=fault('START_EIO');cp.execFileSync=()=>{throw original};syncBuiltinESMExports();
    let error;try{${mode === 'spawn' ? "spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})" : "forkOwnedChild('unused.cjs',{execArgv:['-e','setInterval(()=>{},1000)'],silent:true})"}}catch(e){error=e}
    assert.equal(error.cause,original);assert.equal(getOwnedChildStartFailure(error).child,native);
    cp.execFileSync=realPs;syncBuiltinESMExports();
    assert.equal(await stopOwnedChild(native),undefined);assert(absent(native));assert.equal(error.cause,original);
  `)
}, 12000)

it.each(['leader-missing','leader-group-mismatch','leader-start-missing','early-exit'])('rejects startup %s with a registered partial handle', async reason => {
  await nativeCase(`
    const realSpawn=cp.spawn;let native;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    cp.execFileSync=(...args)=>{assert.equal(args[2].timeout,250);
      ${reason === 'leader-missing' ? "return ''" : reason === 'leader-group-mismatch' ? "return native.pid+' '+process.pid+' Nov 8 2026'" : reason === 'leader-start-missing' ? "return native.pid+' '+native.pid" : "Object.defineProperty(native,'exitCode',{value:0,writable:true});return realPs(...args)"}
    };syncBuiltinESMExports();
    let error;try{spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})}catch(e){error=e}
    assert.equal(error.startResult.reason,${JSON.stringify(reason)});assert.equal(error.cause.reason,${JSON.stringify(reason)});assert.equal(getOwnedChildStartFailure(error).child,native);
    // These are fake table/handle identity probes, not real PID reuse.
    native.exitCode=null;cp.execFileSync=realPs;syncBuiltinESMExports();assert.equal(await stopOwnedChild(native),undefined);assert(absent(native));
  `)
}, 12000)

it('bounds the actual startup exec timeout and retains its original ETIMEDOUT', async () => {
  await nativeCase(`
    const realSpawn=cp.spawn;let native,original;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    cp.execFileSync=(...args)=>{assert.equal(args[2].timeout,250);try{return realPs(process.execPath,['-e','setTimeout(()=>{},2000)'],args[2])}catch(e){original=e;throw e}};syncBuiltinESMExports();
    const began=Date.now();let error;try{spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})}catch(e){error=e}
    assert(Date.now()-began<1500);assert.equal(original.code,'ETIMEDOUT');assert.equal(error.cause,original);assert.equal(getOwnedChildStartFailure(error).child,native);
    cp.execFileSync=realPs;syncBuiltinESMExports();await stopOwnedChild(native);assert(absent(native));
  `)
}, 12000)

it('never signals a provisional group during persistent ps failure and releases every local pipe and IPC handle', async () => {
  await nativeCase(`
    const unrelated=await start(),realSpawn=cp.spawn;let native;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    const original=fault('START_EIO');cp.execFileSync=()=>{throw original};syncBuiltinESMExports();
    let error;try{spawnOwnedChild(process.execPath,['-e',"setInterval(()=>process.stderr.write('x'.repeat(8192)),1)"],{stdio:['pipe','pipe','pipe','ipc','pipe']})}catch(e){error=e}
    const receipt=getOwnedChildStartFailure(error);for(let i=0;i<40;i++)native.emit('error',new Error('event '+i));assert.equal(receipt.errors.length,32);assert.equal(receipt.droppedErrors,8);
    const snapshot=receipt.errors;native.emit('error',original);assert.equal(snapshot.length,32);
    process.kill=(pid,sig)=>{signals.push([pid,sig]);return realKill(pid,sig)};
    const {error:stop}=await capture(native);assert.equal(stop.stopResult.termination,'unconfirmed');assert.equal(stop.stopResult.finalMembers,null);assert.deepEqual(signals,[]);assert(live(native.pid));assert(live(unrelated.pid));assert.equal(native.connected,false);assert(native.stdio.filter(Boolean).every(s=>s.destroyed));assert.equal(error.cause,original);
    cp.execFileSync=realPs;syncBuiltinESMExports();
    const retry=await capture(native);assert.equal(retry.error.stopResult.termination,'confirmed');assert(absent(native));assert(live(unrelated.pid));
  `)
}, 12000)

it('keeps native no-pid async errors and synchronous pre-acquisition throws distinct', async () => {
  await nativeCase(`
    let ps=0;cp.execFileSync=()=>{ps++;throw Error('must not observe no pid')};syncBuiltinESMExports();
    process.kill=(pid,sig)=>{signals.push([pid,sig]);return realKill(pid,sig)};
    for(const create of [()=>spawnOwnedChild('/not-an-executable-625'),()=>forkOwnedChild('unused.cjs',{execPath:'/not-an-executable-625',silent:true})]){const child=create();
      children.push(child);assert.equal(child.pid,undefined);let original,closed=false;
      child.on('error',e=>{original=e});child.on('close',()=>{closed=true});
      await realSleep(50);assert.equal(original.code,'ENOENT');assert.equal(getOwnedChildStartFailure(original),undefined);assert(closed);assert.equal(await stopOwnedChild(child),undefined);
    }
    const realSpawn=cp.spawn,original=fault('SYNC');cp.spawn=()=>{throw original};syncBuiltinESMExports();
    assert.throws(()=>spawnOwnedChild('unused'),e=>e===original);assert.equal(getOwnedChildStartFailure(original),undefined);assert.equal(ps,0);assert.deepEqual(signals,[]);
  `)
}, 12000)

it.each([false,true])('keeps authenticated startup primary through wrapper partial catch (persistent=%s)', async persistent => {
  await nativeCase(`
    const realSpawn=cp.spawn;let native,count=0;const original=fault('START_EIO');
    cp.spawn=(command,args,options)=>{native=realSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);children.push(native);return native};
    cp.execFileSync=(...args)=>{if(${persistent}||count++===0)throw original;return realPs(...args)};syncBuiltinESMExports();
    process.kill=(pid,sig)=>{signals.push(sig);return realKill(pid,sig)};
    let error;try{await startIsolatedNuxt({cwd:process.cwd()})}catch(e){error=e}
    const primary=error instanceof AggregateError?error.errors[0]:error;
    assert.equal(primary.cause,original);assert.equal(getOwnedChildStartFailure(primary).child,native);
    if(${persistent}){assert.equal(error.cause,primary);assert.equal(error.stopResult.termination,'unconfirmed');assert(live(native.pid));assert.deepEqual(signals,[])}else{assert.equal(error,primary);assert(absent(native));assert.deepEqual(signals,['SIGTERM'])}
  `)
}, 12000)


it('refuses to signal unestablished early-exit descendants then confirms only a valid empty group', async () => {
  await nativeCase(`
    const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-early-')),marker=path.join(dir,'ready');
    try {
    let native;const realSpawn=cp.spawn;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    cp.execFileSync=(...args)=>{
      // Block this runtime only, allowing the real launcher to create its child and exit.
      for(let i=0;i<100&&!fs.existsSync(marker);i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      throw fault('EARLY_START_EIO')
    };syncBuiltinESMExports();
    let error;try{spawnOwnedChild(process.execPath,['-e',
      "const cp=require('node:child_process');cp.spawn(process.execPath,['-e',"+JSON.stringify('setInterval(()=>{},1000)')+"],{stdio:'ignore'});require('node:fs').writeFileSync("+JSON.stringify(marker)+",'ready');process.exit(0)"],{stdio:'ignore'})}catch(e){error=e}
    const receipt=getOwnedChildStartFailure(error);assert.equal(receipt.child,native);assert.equal(error.startResult.reason,'observation-failed');
    cp.execFileSync=realPs;syncBuiltinESMExports();await realSleep(100);assert.equal(native.exitCode,0);
    assert(!absent(native));process.kill=(pid,sig)=>{signals.push(sig);return realKill(pid,sig)};
    const result=await capture(native);assert.equal(result.error.stopResult.termination,'unconfirmed');assert.equal(result.error.stopResult.reason,'identity-unverified');assert.deepEqual(signals,[]);assert(!absent(native));
    // Explicit harness recovery, never candidate cleanup credit.
    realKill(-native.pid,'SIGKILL');await realSleep(100);
    assert.equal(await stopOwnedChild(native),undefined);assert(absent(native));
    } finally { fs.rmSync(dir,{recursive:true,force:true}) }
  `)
}, 12000)


it.each(['spawn-options','spawn-args','fork-options','fork-args'])('returns the identical native handle for %s', async mode => {
  await nativeCase(`
    const kind=${JSON.stringify(mode)}.startsWith('spawn')?'spawn':'fork',real=cp[kind];let native;
    cp[kind]=(...args)=>{native=real(...args);children.push(native);return native};syncBuiltinESMExports();
    let child;
    if(${JSON.stringify(mode)}==='spawn-options')child=spawnOwnedChild(process.execPath,{stdio:'pipe'});
    if(${JSON.stringify(mode)}==='spawn-args')child=spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    if(${JSON.stringify(mode)}==='fork-options')child=forkOwnedChild('unused.cjs',{silent:true,execArgv:['-e','setInterval(()=>{},1000)']});
    if(${JSON.stringify(mode)}==='fork-args')child=forkOwnedChild('unused.cjs',[],{stdio:['ignore','ignore','pipe','ipc'],execArgv:['-e','setInterval(()=>{},1000)']});
    assert.equal(child,native);assert.equal(await stopOwnedChild(child),undefined);assert(absent(child));
  `)
}, 12000)


it('retains real native IPC error objects on a partial handle through confirmed stop and removes its temporary listener on close', async () => {
  await nativeCase(`
    const realSpawn=cp.spawn;let native;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    cp.execFileSync=()=>{throw fault('START_EIO')};syncBuiltinESMExports();
    let error;try{spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe','ipc']})}catch(e){error=e}
    const receipt=getOwnedChildStartFailure(error);let event;
    const external=e=>{event=e};native.on('error',external);
    native.disconnect();native.send('after disconnect');await realSleep(25);
    assert.equal(event.code,'ERR_IPC_CHANNEL_CLOSED');assert.equal(receipt.errors[0],event);
    cp.execFileSync=realPs;syncBuiltinESMExports();const result=await capture(native);
    assert.equal(result.error.stopResult.termination,'confirmed');assert(result.error.errors.includes(event));assert(absent(native));
    await realSleep(25);assert.equal(native.listenerCount('error'),1);native.off('error',external);assert.equal(native.listenerCount('error'),0);
  `)
}, 12000)

it.each(['missing', 'wrong-group', 'empty-start'])('refuses provisional stop authority for a live native leader with %s observation', async mode => {
  await nativeCase(`
    const realSpawn=cp.spawn;let native;
    cp.spawn=(...args)=>{native=realSpawn(...args);children.push(native);return native};
    cp.execFileSync=()=>${mode === 'missing' ? "(process.pid+' '+native.pid+' MEMBER')" : mode === 'wrong-group' ? "(native.pid+' '+process.pid+' WRONG')" : "(native.pid+' '+native.pid)"};syncBuiltinESMExports();
    let error;try{spawnOwnedChild(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})}catch(e){error=e}
    assert.equal(getOwnedChildStartFailure(error).child,native);
    process.kill=(pid,sig)=>{signals.push(sig);return realKill(pid,sig)};
    const result=await capture(native);assert.equal(result.error.stopResult.termination,'unconfirmed');assert.equal(result.error.stopResult.reason,'identity-unverified');assert.deepEqual(signals,[]);assert(live(native.pid));
    cp.execFileSync=realPs;syncBuiltinESMExports();assert.equal(await stopOwnedChild(native),undefined);assert(absent(native));
  `)
}, 12000)
