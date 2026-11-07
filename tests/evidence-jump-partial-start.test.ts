import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

// Actual CLI + actual helper. Only native imports are fault boundaries. The
// loopback processes carry lifecycle evidence; they cannot pass browser oracles.
async function runCase(target: number, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-647-test-'))
  const journal = join(dir, 'native.jsonl')
  const helper = pathToFileURL(resolve('scripts/lib/isolated-local-services.mjs')).href
  writeFileSync(join(dir, 'child.cjs'), `
    const fs=require('node:fs');
    const port=process.env.NITRO_PORT;
    fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({event:'carrier-ready',pid:process.pid,kind:process.env.CARRIER_KIND,mode:process.env.CASE_MODE})+'\\n');
    if(process.env.CARRIER_KIND==='builder') { if(process.env.CASE_MODE==='normal')process.exit(0);else setInterval(()=>{},1000); return }
    if(process.env.CARRIER_KIND==='chrome') {
      if(process.env.CASE_MODE==='early') {require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.exit(0)}
      if(['normal','profile-error','result-error','db-error'].includes(process.env.CASE_MODE)) {
        const http=require('node:http');const server=http.createServer((q,s)=>s.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/devtools/test'})));
        server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.PROFILE+'/DevToolsActivePort',server.address().port+'\\n/devtools/test'));
      } else setInterval(()=>{},1000);
    } else setTimeout(()=>require('node:http').createServer((q,s)=>s.end('{}')).listen(Number(port),'127.0.0.1'),process.env.CASE_MODE==='signals'?350:0);
  `)
  writeFileSync(join(dir, 'native.mjs'), `
    import cp from 'node:child_process';import fs from 'node:fs';
    export * from 'node:child_process';
    const log=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');
    let active=0, failed=false, stopPs=0;
    export function spawn(cmd,args,options){
      const kind=cmd==='pnpm'?'builder':args[0]==='.output/server/index.mjs'?'server':'chrome';active={builder:1,server:2,chrome:3}[kind];
      const child=cp.spawn(process.execPath,[${JSON.stringify(join(dir, 'child.cjs'))}],{...options,env:{...options.env,CARRIER_KIND:kind,CASE_MODE:${JSON.stringify(mode)},PROFILE:args.find(x=>x.startsWith('--user-data-dir='))?.slice(16)}});
      log({event:'native',pid:child.pid,index:active,kind,port:options.env.NITRO_PORT,profile:args.find(x=>x.startsWith('--user-data-dir='))?.slice(16)});
      return child;
    }
    export function execFileSync(cmd,args,options){
      if(cmd==='ps' && active===${target}) {
        if(!failed && ${JSON.stringify(!['normal', 'signals', 'profile-error', 'result-error', 'db-error', 'init'].includes(mode))}) {
          failed=true;
          try {return cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},350)'],options)}
          catch(error){log({event:'timeout',code:error.code,timeout:options.timeout,timeoutPid:error.pid});if(${JSON.stringify(mode === 'early')})cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},1000)']);throw error}
        }
        if(failed && ${JSON.stringify(mode === 'unknown')})throw Object.assign(new Error('permanent native EIO'),{code:'EIO'});
        if(failed && ${JSON.stringify(mode === 'confirmed-error')} && stopPs++===0)throw Object.assign(new Error('cleanup native EIO'),{code:'EIO'});
      }
      return cp.execFileSync(cmd,args,options);
    }
  `)
  writeFileSync(join(dir, 'wrapper.mjs'), `
    import * as real from ${JSON.stringify(helper + '?actual')};
    import fs from 'node:fs';export * from ${JSON.stringify(helper + '?actual')};
    const log=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');
    let native, original;
    export function spawnOwnedChild(...args){try{native=real.spawnOwnedChild(...args);return native}catch(error){original=error;native=real.getOwnedChildStartFailure(error)?.child;log({event:'partial',pid:native?.pid,cause:error.cause?.code,authenticated:!!native,clone:!!real.getOwnedChildStartFailure({...error}),forged:!!real.getOwnedChildStartFailure(Object.assign(new Error(),{startResult:{...error.startResult,version:2}}))});throw error}}
    export function getOwnedChildStartFailure(error){const value=real.getOwnedChildStartFailure(error);log({event:'recover',sameError:error===original,sameChild:value?.child===native});return value}
    export async function stopOwnedChild(child){if(${JSON.stringify(mode === 'early')})await new Promise(r=>setTimeout(r,25));log({event:'stop',pid:child.pid,sameChild:child===native});try {await real.stopOwnedChild(child);log({event:'stopped',pid:child.pid})}catch(error){log({event:'stop-error',pid:child.pid,result:error.stopResult});throw error}}
  `)
  writeFileSync(join(dir, 'hook.mjs'), `
    import {registerHooks,syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
    import Database from ${JSON.stringify(pathToFileURL(resolve('node_modules/better-sqlite3/lib/index.js')).href)};
    if(${JSON.stringify(mode === 'multi-errors')}){const close=Database.prototype.close;Database.prototype.close=function(){close.call(this);throw new Error('DB native EIO')}};
    const exists=fs.existsSync, rm=fs.rmSync, write=fs.writeFileSync;
    fs.existsSync=p=>p==='.output/server/index.mjs'||exists(p);
    fs.rmSync=(p,o)=>{if(${JSON.stringify(['profile-error','multi-errors'].includes(mode))}&&String(p).endsWith('/chrome'))throw new Error('profile native EIO');return rm(p,o)};
    fs.writeFileSync=(p,...a)=>{if(${JSON.stringify(['result-error','multi-errors'].includes(mode))}&&String(p).endsWith('/result.json'))throw new Error('result native EIO');return write(p,...a)};
    const kill=process.kill.bind(process);process.kill=(pid,sig)=>{fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({event:'signal',pid,sig})+'\\n');return kill(pid,sig)};
    syncBuiltinESMExports();
    registerHooks({resolve(s,c,n){if(s.endsWith('/lib/isolated-local-services.mjs'))return {url:${JSON.stringify(pathToFileURL(join(dir, 'wrapper.mjs')).href)},shortCircuit:true};return n(s,c)},load(u,c,n){const r=n(u,c);if(u.startsWith(${JSON.stringify(helper)}))return {...r,source:String(r.source).replace("from 'node:child_process'",'from '+${JSON.stringify(JSON.stringify(pathToFileURL(join(dir, 'native.mjs')).href))})};return r}});
  `)
  const child = spawn(process.execPath, ['--import', join(dir, 'hook.mjs'), 'scripts/verify-evidence-page-jump.mjs', ...(target === 1 ? [] : ['--skip-build']), ...(mode === 'init' ? ['--fault','before-start'] : [])], {
    cwd: resolve('.'), env: { ...process.env, TMPDIR: dir, CHROME_BIN: 'synthetic-chrome' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let sent = false
  child.stdout.on('data', x => {
    output += x
    if(mode === 'signals' && !sent && output.includes('server/index.mjs') && output.includes('resource')) {
      sent = true
      child.kill('SIGINT'); setTimeout(()=>child.kill('SIGINT'),20); setTimeout(()=>child.kill('SIGTERM'),40)
    }
  })
  child.stderr.on('data', x => { output += x })
  let hung = false
  let beforeCallerHarness: unknown = null
  const timer = setTimeout(() => {
    hung = true
    beforeCallerHarness = { actor:'observation only before harness SIGKILL caller', journal:existsSync(journal)?readFileSync(journal,'utf8'):'', table:execFileSync('ps',['-A','-o','pid=,pgid='],{encoding:'utf8'}), output }
    child.kill('SIGKILL')
  }, 6500)
  const code = await new Promise<number | null>((res, rej) => { child.once('error', rej); child.once('exit', res) })
  clearTimeout(timer)
  const events = existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []
  const natives = events.filter(x => x.event === 'native')
  const table = () => execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(x => x.trim().split(/\s+/).map(Number))
  const before = table().filter(x => natives.some(n => n.pid === x[1]))
  const root = output.match(/"resource":"root","root":"([^"]+)"/)?.[1]
  const profileExists = root ? existsSync(join(root, 'chrome')) : false
  const result = root && existsSync(join(root, 'result.json')) ? JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) : null
  const ports = [...new Set(natives.map(n=>Number(n.port)).filter(Boolean))]
  if(root && existsSync(join(root,'chrome/DevToolsActivePort'))) ports.push(Number(readFileSync(join(root,'chrome/DevToolsActivePort'),'utf8').split('\n')[0]))
  const listeners = () => ports.map(port=>{
    try {return {port,owners:execFileSync('lsof',['-nP','-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8'})}}
    catch(error: any) {if(error.status===1)return {port,owners:''};throw error}
  })
  const portsBefore = listeners()
  // Freeze observations BEFORE harness recovery. Only logged native groups belong
  // to this harness. Unknown membership never becomes a candidate clean receipt.
  const receipt = { target, mode, code, hung, beforeCallerHarness, output, events, before, root, rootExists:root?existsSync(root):false, profileExists, portsBefore, result }
  for (const n of natives) { try { process.kill(-n.pid, 'SIGKILL') } catch {} }
  await new Promise(res => setTimeout(res, 150))
  const after = table().filter(x => natives.some(n => n.pid === x[1]))
  const portsAfter = listeners()
  rmSync(dir, { recursive: true, force: true })
  if (process.env.EVIDENCE_647_RECEIPTS) {
    mkdirSync(process.env.EVIDENCE_647_RECEIPTS, { recursive: true })
    writeFileSync(join(process.env.EVIDENCE_647_RECEIPTS, `${target}-${mode}.json`), JSON.stringify({ ...receipt, recovery: { actor: 'harness', after, portsAfter, directoryRemoved:!existsSync(dir) } }, null, 2))
  }
  expect(portsAfter.every(x=>x.owners==='')).toBe(true)
  expect(after).toEqual([])
  return receipt
}

it('recovers the original builder timeout handle and stops it once before harness', async () => {
  const r = await runCase(1, 'timeout')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.events.filter(x => x.event === 'timeout')).toMatchObject([{ event: 'timeout', code: 'ETIMEDOUT', timeout: 250 }])
  expect(r.events.filter(x => x.event === 'recover')).toEqual([{ event: 'recover', sameError: true, sameChild: true }])
  expect(r.events.filter(x => x.event === 'stop')).toHaveLength(1)
  expect(r.before).toEqual([])
  expect(r.output).toContain('OwnedChildStartError')
}, 12000)

it.each([2, 3])('stops the original partial acquisition at callsite %s after a real timeout', async target => {
  const r = await runCase(target, 'timeout')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.events.find(x => x.event === 'partial')).toMatchObject({ authenticated: true, cause: 'ETIMEDOUT', clone: false, forged: false })
  expect(r.events.filter(x => x.event === 'recover')).toEqual([{ event: 'recover', sameError: true, sameChild: true }])
  const natives = r.events.filter(x => x.event === 'native')
  expect(r.events.filter(x => x.event === 'stop').map(x => x.pid).sort()).toEqual(natives.map(x => x.pid).sort())
  expect(r.before).toEqual([])
  expect(r.profileExists).toBe(false)
  expect(r.result.children.every((x: any) => x.termination === 'confirmed')).toBe(true)
}, 12000)

it.each([1, 2, 3])('retains unknown callsite %s resources with zero signals and bounded exit', async target => {
  const r = await runCase(target, 'unknown')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.output).toContain('OwnedChildStartError')
  expect(r.output).toContain('permanent native EIO')
  expect(r.output).toContain('RETAIN unconfirmed resources')
  const native = r.events.find(x => x.event === 'native' && x.index === target)
  expect(r.before.some(x => x[1] === native.pid)).toBe(true)
  expect(r.events.filter(x => x.event === 'signal' && x.pid === -native.pid)).toEqual([])
  expect(r.events.filter(x => x.event === 'stop' && x.pid === native.pid)).toHaveLength(1)
  expect(r.events.find(x => x.event === 'stop-error' && x.pid === native.pid).result).toMatchObject({version:1,termination:'unconfirmed',finalMembers:null})
  expect(r.result.children.find((x: any) => x.pid === native.pid).termination).toBe('unconfirmed')
  if (target === 3) expect(r.profileExists).toBe(true)
}, 12000)

it('keeps startup and confirmed cleanup errors independent while removing the profile', async () => {
  const r = await runCase(3, 'confirmed-error')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.output).toContain('OwnedChildStartError')
  expect(r.output).toContain('cleanup native EIO')
  expect(r.events.find(x => x.event === 'stop-error').result.termination).toBe('confirmed')
  expect(r.result.failures.length).toBeGreaterThanOrEqual(2)
  expect(r.profileExists).toBe(false)
  expect(r.before).toEqual([])
}, 12000)

it('never signals an exited unestablished leader with a real surviving descendant', async () => {
  const r = await runCase(3, 'early')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  const native = r.events.find(x => x.event === 'native' && x.index === 3)
  expect(r.before.some(x => x[1] === native.pid && x[0] !== native.pid)).toBe(true)
  expect(r.events.filter(x => x.event === 'signal' && x.pid === -native.pid)).toEqual([])
  expect(r.events.find(x => x.event === 'stop-error').result).toMatchObject({termination:'unconfirmed',reason:'identity-unverified'})
  expect(r.profileExists).toBe(true)
}, 12000)

it.each(['normal','profile-error','result-error'])('cleans real acquired groups in the %s lifecycle carrier without claiming business acceptance', async mode => {
  const r = await runCase(3, mode)
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1) // The synthetic endpoint cannot pass the real CDP/browser oracle.
  expect(r.output).toContain('CDP attach failed')
  expect(r.before).toEqual([])
  expect(r.events.filter(x => x.event === 'stop')).toHaveLength(2)
  expect(r.events.filter(x => x.event === 'stopped')).toHaveLength(2)
  if(mode==='profile-error') { expect(r.output).toContain('profile native EIO'); expect(r.profileExists).toBe(true) }
  else expect(r.profileExists).toBe(false)
  if(mode==='result-error') {expect(r.output).toContain('result native EIO');expect(r.result).toBe(null)}
}, 12000)

it('keeps initialization failure nonzero without starting any native resource', async () => {
  const r = await runCase(2, 'init')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.output).toContain('Injected failure before startup')
  expect(r.events).toEqual([])
  expect(r.before).toEqual([])
}, 12000)

it('keeps the first repeated signal exit code and stops the server only once', async () => {
  const r = await runCase(2, 'signals')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(130)
  expect(r.events.filter(x => x.event === 'stop')).toHaveLength(1)
  expect(r.before).toEqual([])
}, 12000)

it('attempts DB profile and result cleanup independently after startup failure', async () => {
  const r = await runCase(3, 'multi-errors')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  for(const message of ['OwnedChildStartError','DB native EIO','profile native EIO','result native EIO']) expect(r.output).toContain(message)
  expect(r.events.filter(x => x.event === 'stopped')).toHaveLength(2)
  expect(r.before).toEqual([])
  expect(r.profileExists).toBe(true)
  expect(r.result).toBe(null)
}, 12000)

it('stops all three normal acquired groups while the synthetic CDP business lane stays failed', async () => {
  const r = await runCase(1, 'normal')
  expect(r.hung).toBe(false)
  expect(r.code).toBe(1)
  expect(r.output).toContain('CDP attach failed')
  expect(r.events.filter(x => x.event === 'stopped')).toHaveLength(3)
  expect(r.before).toEqual([])
  expect(r.profileExists).toBe(false)
}, 12000)
