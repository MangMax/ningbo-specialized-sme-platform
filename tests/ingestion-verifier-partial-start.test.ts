import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'

const owners = ['platform-query-read', 'snapshot-ingestion-finalization', 'snapshot-ingestion-recovery']
const cwd = resolve(import.meta.dirname, '..')
// OS import boundary only: the helper's authentication, observation and stop code runs unchanged.
async function probe(owner: string, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ingestion-owner-test-'))
  const journal = join(dir, 'native.jsonl')
  const url = (name: string) => pathToFileURL(join(dir, name)).href
  const helper = pathToFileURL(join(cwd, 'scripts/lib/isolated-local-services.mjs')).href
  const nativeCode = mode === 'early-exit' ? "const cp=require('node:child_process');cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();process.exit(0)" : 'setInterval(()=>{},1000)'
  writeFileSync(join(dir, 'native.mjs'), `
export * from 'node:child_process';import * as cp from 'node:child_process';import fs from 'node:fs';import {createRequire} from 'node:module';
const log=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');let count=0;
function start(options){const child=cp.spawn(process.execPath,['-e',${JSON.stringify(nativeCode)}],{...options,stdio:options.stdio});log({event:'native',pid:child.pid,root:options.env.NUXT_FILES_DIR,port:options.env.PORT});if(${JSON.stringify(mode)}.startsWith('established'))setImmediate(()=>child.emit('error',Object.assign(new Error('native IPC EIO'),{code:'EIO'})));return child}
export function spawn(command,args,options){return start(options)}
export function fork(module,args,options){return start(options)}
export function execFileSync(command,args,options){count++;if(count===1 && ${JSON.stringify(mode)}==='early-exit')cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},150)']);if(count===1 && !['established','established-unknown'].includes(${JSON.stringify(mode)})){try{return cp.execFileSync(process.execPath,['-e','setTimeout(()=>{},350)'],options)}catch(e){log({event:'timeout',code:e.code,timeout:options.timeout,pid:e.pid,signal:e.signal});if(${JSON.stringify(mode)}==='oracle-error'){const Database=createRequire(${JSON.stringify(pathToFileURL(join(cwd,'package.json')).href)})('better-sqlite3');Database.prototype.close=function(){throw Object.assign(new Error('native oracle close EIO'),{code:'EIO'})}}throw e}}
if(['unknown','established-unknown'].includes(${JSON.stringify(mode)})&&count>1||(['confirmed-error','root-error-combined'].includes(${JSON.stringify(mode)})&&count===2))throw Object.assign(new Error('native observation EIO'),{code:'EIO'});return cp.execFileSync(command,args,options)}
if(${JSON.stringify(mode)}==='receipt-error'){const out=console.log;console.log=(...args)=>{if(args.some(x=>typeof x==='string'&&x.includes('\"state\":\"stopped\"')))throw new Error('native log write EIO');return out(...args)}}
const kill=process.kill.bind(process);process.kill=(pid,signal)=>{log({event:'signal',pid,signal});return kill(pid,signal)};
`)
  writeFileSync(join(dir, 'public.mjs'), `
import * as h from ${JSON.stringify(helper)};import fs from 'node:fs';export * from ${JSON.stringify(helper)};
const log=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');let original,partial;
process.on('uncaughtExceptionMonitor',e=>{const includes=(value,target)=>Boolean(value&&target)&&(value===target||(value?.errors??[]).some(x=>includes(x,target))||includes(value?.cause,target));log({event:'primary-identity',same:includes(e,original),causeSame:original?.cause===partial?.cause})});
function start(fn,args){try{return fn(...args)}catch(e){original=e;partial=h.getOwnedChildStartFailure(e);log({event:'partial',pid:partial?.child.pid,causeSame:partial?.cause===e.cause});if(${JSON.stringify(mode)}==='clone')throw Object.assign(new Error('cloned startup failure'),{startResult:e.startResult,cause:e.cause});throw e}}
export const spawnOwnedChild=(...a)=>start(h.spawnOwnedChild,a);export const forkOwnedChild=(...a)=>start(h.forkOwnedChild,a);
export function getOwnedChildStartFailure(e){log({event:'recover',original:e===original});return h.getOwnedChildStartFailure(e)}
export async function stopOwnedChild(c){if(${JSON.stringify(mode)}==='early-exit'&&c.exitCode===null&&c.signalCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('native leader did not exit')),2000);c.once('exit',()=>{clearTimeout(timer);resolve()})});log({event:'stop',pid:c.pid,same:partial?c===partial.child:true});try{const out=await h.stopOwnedChild(c);log({event:'terminal',termination:'confirmed'});if(${JSON.stringify(mode)}==='wrong-group-stop')throw Object.assign(new Error('simulated foreign-group stop receipt'),{stopResult:{brand:'isolated-local-services.stop',version:1,termination:'confirmed',groupId:c.pid+1000000}});if(${JSON.stringify(mode)}==='unsupported-stop')throw Object.assign(new Error('unsupported stop version'),{stopResult:{brand:'isolated-local-services.stop',version:2,termination:'confirmed'}});return out}catch(e){log({event:'terminal',result:e.stopResult});throw e}}
`)
  writeFileSync(join(dir, 'fs.mjs'), `export * from 'node:fs';import * as fs from 'node:fs';export function rmSync(...args){if(${JSON.stringify(mode)}.startsWith('root-error'))throw Object.assign(new Error('native root removal EIO'),{code:'EIO'});return fs.rmSync(...args)}`)
  writeFileSync(join(dir, 'hook.mjs'), `
import {registerHooks,syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
const log=x=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(x)+'\\n');const mk=fs.mkdtempSync,md=fs.mkdirSync;
fs.mkdtempSync=(...args)=>{const root=mk(...args);if(/verify-platform-read-|snapshot-finalization-|snapshot-recovery-/.test(root))log({event:'root',root});return root};
fs.mkdirSync=(...args)=>{if(${JSON.stringify(mode)}==='initialization'&&/verify-platform-read-|snapshot-finalization-|snapshot-recovery-/.test(String(args[0])))throw Object.assign(new Error('native initialization EIO'),{code:'EIO'});return md(...args)};syncBuiltinESMExports();registerHooks({load(url,context,next){const r=next(url,context);
if(url===${JSON.stringify(helper)})return {...r,source:String(r.source).replace("from 'node:child_process'",'from '+${JSON.stringify(JSON.stringify(url('native.mjs')))})};
if(url.endsWith('/scripts/verify-${owner}.mjs'))return {...r,source:String(r.source).replace("from './lib/isolated-local-services.mjs'",'from '+${JSON.stringify(JSON.stringify(url('public.mjs')))}).replace("from 'node:fs'",'from '+${JSON.stringify(JSON.stringify(url('fs.mjs')))})};return r}});
`)
  const child = spawn(process.execPath, ['--import', join(dir, 'hook.mjs'), `scripts/verify-${owner}.mjs`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', timedOut = false
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
  const code = await new Promise(resolve => child.once('exit', resolve))
  clearTimeout(timer)
  const events = existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const native = events.find(e => e.event === 'native')
  const root = events.find(e => e.event === 'root')?.root
  const members = () => execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' }).split('\n').filter(line => native && Number(line.trim().split(/\s+/)[1]) === native.pid)
  const before = { actor: 'candidate BEFORE harness', members: members(), rootExists: root ? existsSync(root) : null, code, timedOut, events, output }
  // These PIDs come exclusively from this test's native spawn journal. Recovery is never candidate evidence.
  if (native) { try { process.kill(-native.pid, 'SIGKILL') } catch {} }
  await new Promise(resolve => setTimeout(resolve, 100))
  let portFree = true
  if (native) {
    const server = createServer()
    portFree = await new Promise<boolean>(resolve => { server.once('error', () => resolve(false)); server.listen({host:'127.0.0.1',port:Number(native.port)}, () => server.close(() => resolve(true))) })
  }
  const after = { actor: 'harness only', members: members(), portFree }
  if (root) rmSync(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  const recovery = { actor: 'harness only', rootRemoved: !root || !existsSync(root), journalRootRemoved: !existsSync(dir) }
  if (process.env.INGESTION_TEST_EVIDENCE) {
    mkdirSync(process.env.INGESTION_TEST_EVIDENCE, { recursive: true })
    writeFileSync(join(process.env.INGESTION_TEST_EVIDENCE, `${owner}-${mode}.json`), JSON.stringify({ before, after, recovery }, null, 2))
  }

  expect(after.portFree).toBe(true)
  expect(recovery).toMatchObject({ rootRemoved: true, journalRootRemoved: true })
  if (mode === 'initialization') {
    expect(timedOut).toBe(false)
    expect(code).not.toBe(0)
    expect(output).toContain('native initialization EIO')
    expect(before.rootExists).toBe(false)
    expect(events.filter(e => ['native','stop','signal'].includes(e.event))).toEqual([])
    return
  }
  expect(native, output).toBeDefined()
  expect(after.members).toEqual([])
  expect(timedOut, output).toBe(false)
  expect(code).not.toBe(0)
  if (!mode.startsWith('established')) expect(events.find(e => e.event === 'timeout')).toMatchObject({ code: 'ETIMEDOUT', timeout: 250 })
  expect(events.filter(e => e.event === 'recover')).toEqual(mode.startsWith('established') ? [] : [{ event: 'recover', original: mode !== 'clone' }])
  expect(events.filter(e => e.event === 'stop')).toEqual(mode === 'clone' ? [] : [{ event: 'stop', pid: native.pid, same: true }])
  if (!mode.startsWith('established')) expect(events.find(e => e.event === 'partial')).toMatchObject({ causeSame: true })
  expect(output).toContain(mode.startsWith('established') ? 'native IPC EIO' : mode === 'clone' ? 'cloned startup failure' : 'OwnedChildStartError')
  if (!mode.startsWith('established') && mode !== 'clone') expect(events.find(e => e.event === 'primary-identity')).toMatchObject({ same: true, causeSame: true })
  expect(output).not.toContain('\"passed\":true')
  if (['unknown', 'established-unknown', 'clone', 'early-exit', 'unsupported-stop', 'wrong-group-stop'].includes(mode)) {
    if (!['unsupported-stop','wrong-group-stop'].includes(mode)) expect(events.filter(e => e.event === 'signal')).toEqual([])
    if (['unsupported-stop','wrong-group-stop'].includes(mode)) expect(before.members).toEqual([])
    else expect(before.members.length).toBeGreaterThan(0)
    expect(before.rootExists).toBe(true)
    if (!['clone','unsupported-stop','wrong-group-stop'].includes(mode)) expect(events.find(e => e.event === 'terminal').result).toMatchObject({ version: 1, termination: 'unconfirmed', finalMembers: null })
  } else {
    expect(before.members).toEqual([])
    expect(before.rootExists).toBe(mode.startsWith('root-error') || mode === 'oracle-error')
    if (mode === 'oracle-error') expect(output).toContain('native oracle close EIO')
    if (mode === 'receipt-error') expect(output).toContain('native log write EIO')
    if (mode.startsWith('root-error')) expect(output).toContain('native root removal EIO')
    if (['confirmed-error','root-error-combined'].includes(mode)) expect(output).toContain('native observation EIO')
  }
}
for (const owner of owners) {
  if (owner !== 'platform-query-read') for (const mode of ['oracle-error','receipt-error']) it(`${owner} lifecycle carrier ${mode} attempts remaining cleanup`, async () => { await probe(owner, mode) }, 40000)
  for (const mode of ['initialization', 'root-error', 'root-error-combined', 'clone', 'early-exit', 'unsupported-stop', 'wrong-group-stop', 'established', 'established-unknown']) it(`${owner} lifecycle carrier ${mode} preserves failure and resource gates`, async () => { await probe(owner, mode) }, 40000)
  it(`${owner} recovers authentic partial after actual native timeout and stops same child once`, async () => { await probe(owner, 'confirmed') }, 40000)
  it(`${owner} retains unknown root with zero signals and exits finitely`, async () => { await probe(owner, 'unknown') }, 40000)
  it(`${owner} retains primary and confirmed cleanup errors independently`, async () => { await probe(owner, 'confirmed-error') }, 40000)
}
