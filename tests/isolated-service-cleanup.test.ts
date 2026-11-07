import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { spawnOwnedChild as spawn, forkOwnedChild as fork, stopOwnedChild, waitForHttp } from '../scripts/lib/isolated-local-services.mjs'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
it('stops native descendants after the launcher exits without stopping an unrelated service', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  const launcher = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
    child.on('message',()=>process.send({pid:child.pid}));
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let nativePid: number | undefined
  try {
    const [ready] = await once(launcher, 'message')
    nativePid = (ready as { pid: number }).pid
    expect(alive(nativePid)).toBe(true)
    await stopOwnedChild(launcher)
    expect(launcher.exitCode).toBe(0)
    expect(alive(nativePid)).toBe(false)
    expect(alive(unrelated.pid!)).toBe(true)
  } finally {
    for (const child of [launcher, unrelated]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL')
    for (let i = 0; i < 40 && nativePid && alive(nativePid); i++) await sleep(25)
  }
}, 12000)

it('accepts an already exited owned child without signalling the current process', async () => {
  const child: ChildProcess = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await once(child, 'exit')
  expect(await stopOwnedChild(child)).toBeUndefined()
  expect(await stopOwnedChild(child)).toBeUndefined()
  expect(child.exitCode).toBe(0)
  expect(alive(process.pid)).toBe(true)
})

it('retains native ownership when the launcher exits before cleanup is called', async () => {
  const launcher = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});const s=require('node:http').createServer((q,r)=>r.end('ready'));s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));"],{stdio:['ignore','ignore','ignore','ipc']});
    child.on('message',m=>process.send({pid:child.pid,port:m.port}));
    process.on('message',()=>process.exit(0));setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let nativePid: number | undefined
  try {
    const [ready] = await once(launcher, 'message')
    const record = ready as { pid: number; port: number }
    nativePid = record.pid
    await waitForHttp(`http://127.0.0.1:${record.port}`, { child: launcher })
    const exited = once(launcher, 'exit')
    launcher.send('exit')
    await exited
    expect(alive(nativePid)).toBe(true)
    await stopOwnedChild(launcher)
    expect(alive(nativePid)).toBe(false)
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL')
    for (let i = 0; i < 40 && nativePid && alive(nativePid); i++) await sleep(25)
  }
}, 12000)

it.each(['spawn', 'fork'] as const)('collects a descendant born just before %s launcher exit without readiness sampling', async mode => {
  const { mkdtempSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'owned-exit-window-'))
  const ready = join(dir, 'ready')
  const code = `
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`)}],{stdio:'ignore'});
    process.send({pid:child.pid},()=>process.exit(0));
  `
  const entry = join(dir, 'launcher.cjs')
  writeFileSync(entry, code)
  const launcher = mode === 'fork'
    ? fork(entry, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    : spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let nativePid: number | undefined
  try {
    const exited = once(launcher, 'exit')
    const [record] = await once(launcher, 'message')
    nativePid = (record as { pid: number }).pid
    await exited
    for (let i = 0; i < 80 && !existsSync(ready); i++) await sleep(25)
    expect(existsSync(ready)).toBe(true)
    expect(alive(nativePid)).toBe(true)
    await stopOwnedChild(launcher)
    expect(alive(nativePid)).toBe(false)
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL')
    for (let i = 0; i < 40 && nativePid && alive(nativePid); i++) await sleep(25)
    rmSync(dir, { recursive: true, force: true })
  }
}, 12000)
