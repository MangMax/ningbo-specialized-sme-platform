import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

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
  await stopOwnedChild(child)
  expect(child.exitCode).toBe(0)
  expect(alive(process.pid)).toBe(true)
})
