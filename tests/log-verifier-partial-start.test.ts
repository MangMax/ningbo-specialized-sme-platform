import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

// Public CLI + unmodified helper semantics. Only native process/FS boundaries
// are faulted; wrappers journal public calls and never manufacture receipts.
const cwd = resolve('.')
const evidence = process.env.LOG_VERIFIER_EVIDENCE
const owners = ['verify-log-sheet-ui-180', 'verify-logs-ui-browser', 'verify-logs-ui', 'verify-logs-ui-browser/chrome']
for (const owner of owners) for (const mode of ['timeout', 'unknown', 'confirmed-error', 'early', ...(owner.includes('sheet') || owner.endsWith('/chrome') ? ['profile-error'] : []), 'normal-carrier', 'repeated-signal', ...(owner.includes('browser') ? ['log-error'] : []), 'launch-error', ...(owner === 'verify-logs-ui' ? ['db-read-error'] : []), ...(owner.includes('sheet') || owner.endsWith('/chrome') ? ['cdp-error'] : [])]) {
  it(`${owner}: ${mode} preserves accountable lifecycle before harness recovery`, async () => {
    const script = owner.split('/')[0]
    const unknown = mode === 'unknown' || mode === 'early'
    const root = mkdtempSync(join(tmpdir(), 'log-owner-test-'))
    const journal = join(root, 'native.jsonl')
    const log = (data: unknown) => writeFileSync(join(root, 'before-harness.json'), JSON.stringify(data, null, 2))
    const helper = resolve('scripts/lib/isolated-local-services.mjs')
    writeFileSync(join(root,'early.cjs'), `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(join(root,'early-ready'))},String(c.pid));process.exit(0)` )
    writeFileSync(join(root, 'native.mjs'), `
      export * from 'node:child_process';
      import * as cp from 'node:child_process';import fs from 'node:fs';
      let first=true;let target=false; const record=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');
      export function spawn(command,args,options){
        const isFixture=args[0]==='scripts/verify-logs-ui-usability.mjs';

        if (${JSON.stringify(mode)}==='launch-error'&&!(${JSON.stringify(owner.endsWith('/chrome'))}&&isFixture)){record({kind:'launch-error',command,profile:args.find(a=>a.startsWith('--user-data-dir='))?.slice(16),root:options.env?.NUXT_DB_PATH});throw Object.assign(new Error('native launch EIO'),{code:'EIO'})}
        const child=cp.spawn(process.execPath,${JSON.stringify(owner.endsWith('/chrome'))}&&isFixture?['--import',${JSON.stringify(join(root,'carrier-hook.mjs'))},${JSON.stringify(join(root,'producer.mjs'))}]:${JSON.stringify(mode)}==='cdp-error'?[${JSON.stringify(join(root,'chrome.mjs'))},args.find(a=>a.startsWith('--user-data-dir='))?.slice(16)]:${JSON.stringify(mode)}==='early'?[${JSON.stringify(join(root,'early.cjs'))}]:['-e',${JSON.stringify(mode)}==='normal-carrier'?'setTimeout(()=>{},150)':'setInterval(()=>{},1000)'],options);
        target=!(${JSON.stringify(owner.endsWith('/chrome'))}&&isFixture);record({kind:'native',target,pid:child.pid,command,args,profile:args.find(a=>a.startsWith('--user-data-dir='))?.slice(16),root:options.env?.NUXT_DB_PATH});return child;
      }
      export function execFileSync(command,args,options){
        if(command==='ps'&&target&&!['normal-carrier','cdp-error'].includes(${JSON.stringify(mode)})){
          if(first){first=false;if(${JSON.stringify(mode)}==='early'){const until=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(join(root,'early-ready'))})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)}try{return cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},350)'],options)}catch(e){record({kind:'timeout',code:e.code,signal:e.signal});throw e}}
          if(${JSON.stringify(mode)}==='unknown')throw Object.assign(new Error('native permanent EIO'),{code:'EIO'});
          if(${JSON.stringify(mode)}==='confirmed-error'&&!globalThis.stopFault){globalThis.stopFault=true;throw Object.assign(new Error('native transient EIO'),{code:'EIO'})}
        }return cp.execFileSync(command,args,options);
      }
    `)
    writeFileSync(join(root, 'hook.mjs'), `
      import {registerHooks} from 'node:module';import fs from 'node:fs';import cp from 'node:child_process';
      const journal=${JSON.stringify(journal)};const record=x=>fs.appendFileSync(journal,JSON.stringify(x)+'\\n');
      const read=fs.readFileSync;let dbReads=0;fs.readFileSync=(path,...args)=>{if(${JSON.stringify(mode)}==='db-read-error'&&String(path).endsWith('synthetic.db')&&++dbReads>1)throw Object.assign(new Error('DB read EIO'),{code:'EIO'});return read(path,...args)};
      const write=fs.writeFileSync;fs.writeFileSync=(path,...args)=>{if(${JSON.stringify(mode)}==='log-error'&&String(path).endsWith('fixture.log'))throw Object.assign(new Error('log EIO'),{code:'EIO'});return write(path,...args)};
      const rm=fs.rmSync;fs.rmSync=(path,...args)=>{if(${JSON.stringify(mode)}==='profile-error'&&String(path).includes('chrome-'))throw Object.assign(new Error('profile EIO'),{code:'EIO'});return rm(path,...args)};
      const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
      globalThis.logPrimary=error=>record({kind:'primary-identity',sameError:error===globalThis.logStartError});
      const kill=process.kill.bind(process);process.kill=(pid,signal)=>{record({kind:'signal',pid,signal});return kill(pid,signal)};
      registerHooks({load(url,context,next){const r=next(url,context);if(process.env.LOG_VERIFIER_BASELINE&&url.endsWith('/scripts/${script}.mjs'))return {...r,source:cp.execFileSync('git',['show','90f5994842eec047f2d7e8ffb57568db64cec816:scripts/${script}.mjs'],{encoding:'utf8'})};if(url.endsWith('/scripts/${script}.mjs'))return {...r,source:String(r.source).replace('function errorDetail(error) {',"function errorDetail(error) { if(error?.name==='OwnedChildStartError')globalThis.logPrimary(error);")};if(url===${JSON.stringify(new URL('file://' + helper).href)}){
        let s="import fs from 'node:fs';const record=x=>fs.appendFileSync("+JSON.stringify(journal)+",JSON.stringify(x)+String.fromCharCode(10));"+String(r.source).replace("from 'node:child_process'",'from '+JSON.stringify(${JSON.stringify(new URL('file://' + join(root, 'native.mjs')).href)}));
        s=s.replace('export const spawnOwnedChild =','const nativeStart =').replace('export async function stopOwnedChild(','async function nativeStop(');
        s+=\`\nexport function spawnOwnedChild(...args){try{return nativeStart(...args)}catch(error){const p=getOwnedChildStartFailure(error);globalThis.logStartError=error;globalThis.logPartialChild=p?.child;record({kind:'start-error',sameCause:p?.cause===error.cause,clonesRejected:!getOwnedChildStartFailure(Object.assign(new Error(error.message),error))&&!getOwnedChildStartFailure({startResult:{...error.startResult,version:2}}),pid:p?.child.pid,message:error.message,cause:error.cause?.code});throw error}}\nexport async function stopOwnedChild(child){record({kind:'stop',pid:child.pid});if(globalThis.logPartialChild)record({kind:'stop-identity',pid:child.pid,sameChild:child===globalThis.logPartialChild});try{await nativeStop(child);record({kind:'stopped',pid:child.pid})}catch(error){record({kind:'stop-error',pid:child.pid,result:error.stopResult});throw error}}\n\`;
        return {...r,source:s};}return r;}});
    `)
    // A lifecycle-only producer: its native descendant has the exact validated
    // command, and its loopback health request is real. It cannot pass UI oracles.
    writeFileSync(join(root,'carrier-hook.mjs'), `import {registerHooks} from 'node:module';registerHooks({load(url,c,next){const r=next(url,c);if(url.endsWith('/nuxt/bin/nuxt.mjs'))return {...r,source:"import http from 'node:http';http.createServer((q,s)=>s.end('ok')).listen(Number(process.argv.at(-1)),'127.0.0.1');"};return r}})`)
    writeFileSync(join(root,'producer.mjs'), `
      import cp from 'node:child_process';import fs from 'node:fs';import net from 'node:net';import {join} from 'node:path';
      const tmp=${JSON.stringify(root)};const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
      const child=cp.spawn(process.execPath,['--import',join(tmp,'carrier-hook.mjs'),join(${JSON.stringify(cwd)},'node_modules/nuxt/bin/nuxt.mjs'),'dev','--host','127.0.0.1','--port',String(port)],{stdio:'ignore'});
      // --import would change the command contract; inherit hook via NODE_OPTIONS instead.
    `)
    // Use NODE_OPTIONS to keep ps command byte-exact.
    let producer=readFileSync(join(root,'producer.mjs'),'utf8').replace("['--import',join(tmp,'carrier-hook.mjs'),join(","[join(").replace("{stdio:'ignore'}","{stdio:'ignore',env:{...process.env,NODE_OPTIONS:'--import '+join(tmp,'carrier-hook.mjs')}}")
    producer+=`const base='http://127.0.0.1:'+port;let status;for(let i=0;i<100;i++){try{status=(await fetch(base+'/api/health')).status;break}catch{await new Promise(r=>setTimeout(r,20))}}if(status!==200)throw Error('carrier health');
      const source={sha:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:cp.execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim()};
      const marker=Buffer.from('tiny carrier');fs.writeFileSync(join(tmp,'tiny.db'),marker);
      fs.writeFileSync(process.env.LOGS_UI_MANIFEST_PATH,JSON.stringify({root:tmp,synthetic:true,source,port,base,pagePath:'/logs?from=2026-01-01&to=2026-01-02',pid:child.pid,realEvent:{requestId:'carrier'},realNormalEvent:{operation:'http.request',httpMethod:'GET',httpRoute:'/api/health',statusCode:status,synthetic:false,requestId:'carrier-health'}}));
      console.log('Serving synthetic logs fixture at '+base+'/logs?from=2026-01-01&to=2026-01-02');
      process.on('SIGTERM',()=>{child.once('exit',()=>{fs.writeFileSync(join(tmp,'closeout.json'),JSON.stringify({businessUnchanged:marker.equals(fs.readFileSync(join(tmp,'tiny.db'))),outputPrivacy:true}));process.exit(0)});child.kill('SIGTERM')});setInterval(()=>{},1000);`
    writeFileSync(join(root,'producer.mjs'),producer)
    writeFileSync(join(root,'chrome.mjs'), `import http from 'node:http';import fs from 'node:fs';import {join} from 'node:path';
      const server=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/devtools/carrier'}))});
      server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync(join(process.argv[2],'DevToolsActivePort'),port+'\\n/devtools/carrier');fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({kind:'listener',pid:process.pid,port})+'\\n')});`)
    const args = ['--import', join(root, 'hook.mjs'), `scripts/${script}.mjs`]
    if (owner.includes('sheet')) args.push('http://127.0.0.1:1', join(root, 'out'))
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, LOGS_UI_BROWSER_OUT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 8000)
    let signalsSent = false
    const signalTimer = setInterval(() => {
      if (mode !== 'repeated-signal' || signalsSent || !existsSync(journal)) return
      if (!readFileSync(journal,'utf8').includes('\"kind\":\"stop\"')) return
      signalsSent = true; child.kill('SIGTERM'); child.kill('SIGTERM'); child.kill('SIGINT')
    }, 1)
    const code = await new Promise<number | null>(res => child.once('exit', res)); clearTimeout(timer); clearInterval(signalTimer)
    const events = existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : []
    const table = () => execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    const before = table()
    const natives = events.filter(e => e.kind === 'native')
    const snapshot = { owner, mode, code, timedOut, events, output, table: before, resources: natives.map(e => ({...e, profileExists: e.profile && existsSync(e.profile), groupPresent: before.split('\n').some(l => Number(l.trim().split(/\s+/)[1]) === e.pid)})) }
    const { readdirSync, cpSync } = await import('node:fs')
    const receiptPaths = [join(root,'out','sheet-browser-closeout.json'), ...readdirSync(root).filter(n=>n.startsWith('run-')).map(n=>join(root,n,'browser-closeout.json')), ...events.filter(e=>e.root).map(e=>join(resolve(e.root,'..'),'lifecycle.json'))]
    const receipts = receiptPaths.filter(existsSync).map(path=>({path,body:JSON.parse(readFileSync(path,'utf8'))}))
    Object.assign(snapshot,{receipts,signalsSent})
    for (const e of events.filter(e=>e.root)) cpSync(resolve(e.root,'..'),join(root,'public-root'),{recursive:true})
    const ports = events.filter(e=>e.kind==='listener').map(e=>e.port)
    // The browser puts its manifest in the fresh run directory.
    for(const name of readdirSync(root).filter(n=>n.startsWith('run-'))) {
      const path=join(root,name,'fixture-manifest.json');if(existsSync(path))ports.push(JSON.parse(readFileSync(path,'utf8')).port)
    }
    const reachable = async (port: number) => { try { await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(250)});return true } catch {return false} }
    const portStates = await Promise.all(ports.map(async port=>({port,reachableBeforeHarness:await reachable(port)})))
    Object.assign(snapshot,{portStates})
    log(snapshot)
    try {
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(1)
      if (mode === 'repeated-signal') expect(signalsSent).toBe(true)
      expect(portStates.every(p=>!p.reachableBeforeHarness)).toBe(true)
      expect(receipts.length).toBeGreaterThan(0)
      const native = natives.find(e => e.target)
      if(mode==='log-error'&&owner.endsWith('/chrome')) {
        expect(native).toBeUndefined();expect(output).toContain('log EIO');expect(natives).toHaveLength(1)
        expect(events.filter(e=>e.kind==='stop')).toEqual([{kind:'stop',pid:natives[0].pid}])
        expect(snapshot.resources[0].groupPresent).toBe(false);return
      }
      if(mode==='launch-error') {
        expect(native).toBeUndefined()
        expect(events.filter(e=>e.kind==='stop'&&!natives.some(n=>n.pid===e.pid))).toEqual([])
        const attempt=events.find(e=>e.kind==='launch-error');expect(attempt).toBeTruthy()
        if(attempt.profile)expect(existsSync(attempt.profile)).toBe(true)
        expect(output).toContain('native launch EIO')
        return
      }
      expect(native).toBeTruthy()
      if(mode==='db-read-error') {expect(JSON.stringify(receipts)).toContain('DB read EIO');expect(JSON.stringify(receipts)).toContain('ETIMEDOUT')}
      if(mode==='profile-error') {expect(JSON.stringify(receipts)).toContain('profile EIO');expect(JSON.stringify(receipts)).toContain('ETIMEDOUT')}
      if(mode==='log-error') {expect(JSON.stringify(receipts)).toContain('log EIO');expect(JSON.stringify(receipts)).toContain('ETIMEDOUT')}
      expect(events.filter(e => e.kind === 'timeout')).toHaveLength(['normal-carrier','cdp-error'].includes(mode) ? 0 : 1)
      if (!['normal-carrier','cdp-error'].includes(mode)) expect(events.find(e => e.kind === 'start-error')).toMatchObject({pid: native.pid, sameCause: true, clonesRejected: true, cause: 'ETIMEDOUT'})
      expect(events.filter(e => e.kind === 'stop' && e.pid === native.pid)).toEqual([{kind: 'stop', pid: native.pid}])
      if(!['normal-carrier','cdp-error'].includes(mode)) {
        expect(events.find(e=>e.kind==='stop-identity'&&e.pid===native.pid)?.sameChild).toBe(true)
        expect(events.find(e=>e.kind==='primary-identity')?.sameError).toBe(true)
      }
      expect(snapshot.resources.find(e => e.pid === native.pid).groupPresent).toBe(unknown)
      if (mode === 'confirmed-error') expect(events.find(e=>e.kind==='stop-error'&&e.pid===native.pid)?.result).toMatchObject({brand:'isolated-local-services.stop',version:1,termination:'confirmed',groupId:native.pid})
      if (unknown) expect(events.find(e=>e.kind==='stop-error'&&e.pid===native.pid)?.result).toMatchObject({termination:'unconfirmed',groupId:native.pid})
      if (native.profile) expect(existsSync(native.profile)).toBe(unknown || mode === 'profile-error')
      if (unknown) expect(events.filter(e => e.kind === 'signal' && e.pid === -native.pid)).toEqual([])
      else if (mode !== 'normal-carrier') expect(events.some(e => e.kind === 'signal' && e.pid === -native.pid)).toBe(true)
    } finally {
      // Harness recovery is deliberately after the independent native snapshot.
      for (const e of natives) { try { process.kill(-e.pid, 'SIGKILL') } catch {} }
      await new Promise(r => setTimeout(r, 100))
      const after = table()
      writeFileSync(join(root, 'recovery.json'), JSON.stringify({actor:'harness', groups:natives.map(e=>e.pid), after}, null, 2))
      for (const e of natives) expect(after.split('\n').some(l=>Number(l.trim().split(/\s+/)[1])===e.pid), 'harness must reap its own groups').toBe(false)
      if (evidence) { mkdirSync(evidence, {recursive:true}); const {cpSync}=await import('node:fs');cpSync(root,join(evidence,owner.replace('/','-')+'-'+mode),{recursive:true}) }
      for (const e of events.filter(e=>e.kind==='native'||e.kind==='launch-error')) { if(e.profile) rmSync(e.profile,{recursive:true,force:true});if(e.root)rmSync(resolve(e.root,'..'),{recursive:true,force:true}) }
      rmSync(root,{recursive:true,force:true})
    }
  }, 15000)
}
