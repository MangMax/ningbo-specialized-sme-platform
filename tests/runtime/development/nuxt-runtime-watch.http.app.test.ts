import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'

it('does not scan changing runtime databases as icon source while real API errors and logging remain available', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const id = `runtime-watch-${randomUUID()}`
  const dir = mkdtempSync(join(tmpdir(), 'nuxt-runtime-watch-'))
  const cache = join(root, '.cache', id)
  const sentinel = join(root, '.runtime-logs', `${id}.db`)
  const component = join(root, 'layers/core/app/components/files', `RuntimeWatch${id.replaceAll('-', '')}.vue`)
  const route = join(root, 'layers/core/server/api/files', `${id}.get.ts`)
  const trace = join(dir, 'reads.jsonl')
  const preload = join(dir, 'observe.cjs')
  let child: ChildProcess | undefined
  let output = ''
  try {
    mkdirSync(cache, { recursive: true })
    mkdirSync(join(root, '.runtime-logs'), { recursive: true })
    // Observe the real fs boundary used by Nuxt Icon, not a mocked watcher.
    writeFileSync(preload, `const fs=require('node:fs'),p=require('node:fs/promises');const read=p.readFile;fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({loaded:process.pid})+'\\n');p.readFile=function(file,...args){const path=String(file);if(path===${JSON.stringify(sentinel)}||path.startsWith(${JSON.stringify(cache + '/')}))fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({read:path})+'\\n');if([${JSON.stringify(component)},${JSON.stringify(route)}].includes(path))fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({source:path})+'\\n');return read.call(this,file,...args)};require('node:module').syncBuiltinESMExports();`)
    const port = await reserveLoopbackPort()
    initializeDb({ dbPath: join(dir, 'business.db'), create: true }).$client.close()
    child = spawn(process.execPath, [join(root, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        NODE_OPTIONS: `--require=${preload}`, NUXT_BUILD_DIR: join(dir, 'build'),
        NUXT_LOG_DIR: join(cache, 'logs'), NUXT_DB_PATH: join(dir, 'business.db'),
        NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
      },
    })
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', data => { output = (output + data).slice(-12000) })
    const base = `http://127.0.0.1:${port}`
    await waitForHttp(base + '/api/health', { child, timeoutMs: 60000 })
    // Same-named source directories must still participate in development.
    writeFileSync(component, '<template><span>watch source control</span></template>')
    writeFileSync(route, "export default defineEventHandler(() => ({ watched: true }))")
    const sourceResponse = await waitForHttp(base + `/api/files/${id}`, { child, timeoutMs: 60000 })
    expect(await sourceResponse.json()).toEqual({ watched: true })
    for (let i = 0; i < 6; i++) {
      writeFileSync(sentinel, Buffer.alloc(65536, i))
      const response = await fetch(base + '/api/jobs/not-a-valid-job')
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ statusCode: 400 })
      expect((await fetch(base + '/api/health')).status).toBe(200)
      await sleep(100)
    }
    await sleep(500)
    const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.some(row => row.loaded)).toBe(true)
    expect(records.some(row => row.source === component)).toBe(true)
    expect(records.some(row => row.source === route)).toBe(true)
    expect(records.filter(row => row.read)).toEqual([])
    expect(existsSync(join(cache, 'logs/events.db'))).toBe(true)
    expect(child.exitCode).toBeNull()
  } catch (error) { throw new Error(String(error) + '\n' + output, { cause: error }) }
  finally {
    try { if (child) await stopOwnedChild(child) }
    finally { rmSync(component, { force: true }); rmSync(route, { force: true }); rmSync(sentinel, { force: true }); rmSync(cache, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
  }
}, 90000)
