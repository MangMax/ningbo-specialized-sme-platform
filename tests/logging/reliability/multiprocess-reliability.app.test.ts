import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { type ChildProcess } from 'node:child_process'
import { createLogService } from '../../../layers/core/lib/logging/sqlite-service'
import { spawnOwnedChild as spawn, stopOwnedChild } from '../../support/owned-process.mjs'

it('keeps all query attempt counts and terminals from four real processes sharing one SQLite store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'logging-four-writers-180-'))
  const directory = join(root, 'logs'), children: ChildProcess[] = []
  const reader = createLogService({ directory })
  const deadline = Date.now() + 10000
  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('owned writer deadline')), Math.max(1, deadline - Date.now())) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  try {
    await reader.policy()
    const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
    const script = join(root, 'writer.mjs')
    writeFileSync(script, `
import {createRequire} from 'node:module'
const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jiti)})
const {createLogService}=await createJiti(import.meta.url).import(${JSON.stringify(resolve('layers/core/lib/logging/sqlite-service.ts'))})
const service=createLogService({directory:${JSON.stringify(directory)},stdout:false})
const writer=process.argv[2]
await service.policy()
process.on('message',async message=>{
 try {
  if(message==='go') {
   for(let task=0;task<100;task++) {
    for(let q=0;q<100;q++) service.emit({source:'system',operation:'db.query.select',outcome:'started',level:'debug',origin:{runtime:'node',integration:'drizzle',capture:'hook'},resourceType:'database_connection',resourceId:'primary',requestId:writer})
    service.emit({source:'task',operation:'task.finished',outcome:'success',taskId:writer+'-task-'+task,requestId:writer})
   }
   await service.close()
   process.send({done:true,status:service.status()},()=>process.disconnect())
  }
 } catch {process.send({error:'owned_writer_failed'},()=>process.disconnect());process.exitCode=1}
})
process.send({ready:true})
`)
    const finished: Promise<any>[] = []
    for (let i = 0; i < 4; i++) {
      const child = spawn(process.execPath, [script, `writer-${i}`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child)
      const ready = new Promise<void>((resolveReady, reject) => {
        const onExit = () => reject(new Error('owned writer exited before readiness'))
        child.once('error', reject); child.once('exit', onExit)
        child.once('message', (message: any) => { child.off('exit', onExit); message.ready ? resolveReady() : reject(new Error('owned writer readiness failed')) })
      })
      // Install before readiness to avoid missing a fast completion/exit.
      const completion = new Promise((resolveDone, reject) => {
        child.once('error', reject)
        let result: any
        child.on('message', (message: any) => { if (message.done) result = message; if (message.error) reject(new Error(message.error)) })
        child.once('exit', (code, signal) => code === 0 && result ? resolveDone(result) : reject(new Error(`owned writer exit ${code}/${signal}`)))
      })
      // Teardown can reject a child before all readers are ready. Keep that
      // rejection handled; Promise.all below still propagates the same error.
      void completion.catch(() => {})
      finished.push(completion)
      await bounded(ready)
    }
    for (const child of children) child.send('go')
    const statuses = (await bounded(Promise.all(finished))).map(result => result.status)
    for (const status of statuses) expect(status).toMatchObject({ accepted: 200, coalesced: 9900, stored: 200, dropped: 0, writeUnknown: 0, drainFailures: 0, overflow: 0, queuedEntries: 0, inFlightEntries: 0, closed: true })
    const rows = []; let cursor: string | null | undefined
    do { const page = await reader.list({ limit: 100, ...(cursor ? { cursor } : {}) }); rows.push(...page.rows); cursor = page.nextCursor } while (cursor)
    expect(rows).toHaveLength(800)
    const queries = rows.filter(row => row.origin?.integration === 'drizzle')
    expect(queries.reduce((sum, row) => sum + row.counts!.total!, 0)).toBe(40000)
    for (let writer = 0; writer < 4; writer++) {
      const owned = rows.filter(row => row.requestId === `writer-${writer}`)
      expect(owned.filter(row => row.source === 'task')).toHaveLength(100)
      expect(owned.filter(row => row.source === 'system').reduce((sum, row) => sum + row.counts!.total!, 0)).toBe(10000)
    }
  } finally {
    await Promise.all(children.map(child => stopOwnedChild(child)))
    await reader.close(); rmSync(root, { recursive: true, force: true })
  }
}, 20000)
