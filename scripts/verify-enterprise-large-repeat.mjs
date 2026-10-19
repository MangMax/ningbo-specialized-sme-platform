#!/usr/bin/env node
// Uninstrumented compiled HTTP control. No preload, GC hook, retries or child
// observers: their allocation/timing can hide the old-generation failure.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fork, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb, schema: s } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'enterprise-large-repeat-'))
const dbPath = join(dir, 'synthetic.db'), size = 96 * 1024 * 1024
const db = useDb({ dbPath, migrationsFolder: resolve('db/migrations') })
const id = db.insert(s.enterprise).values({ name: '合成原文企业', nameNorm: '合成原文企业' }).returning().get().id
const query = db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: 'name:合成原文企业', queriedAt: '2026-10-19', status: 'partial' }).returning().get()
db.$client.prepare("insert into platform_relation(query_id,sequence_no,enterprise_id,created_at,raw_fields) values(?,1,null,'2026-10-19',json_object('original',replace(hex(zeroblob(?)),'00','x')))").run(query.id, size)
db.$client.close()
const expectedHash = '9aa21bac45c5b07fafeef4a1920f240f3766ab323161abc95f2a18ca385c64cb'
const selected = process.argv[2] ?? 'all'
assert.ok(['all', 'default', '2048'].includes(selected))
console.log(JSON.stringify({ testName: 'repeated complete 96MiB detail without observers', source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'), node: process.version, uninstrumented: true }))
try {
  for (const heap of selected === 'all' ? ['default', '2048'] : [selected]) {
    for (let fresh = 0; fresh < 3; fresh++) {
      const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
      const execArgv = heap === 'default' ? [] : ['--max-old-space-size=2048']
      // The driver's flags and NODE_OPTIONS must never reach the application.
      const { NODE_OPTIONS: _options, ...env } = process.env
      const child = fork(resolve('.output/server/index.mjs'), [], { cwd: dir, execArgv,
        env: { ...env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let output = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-16000) })
      try {
        await waitForHttp(base + '/api/health', { child, timeoutMs: 20000 })
        for (let round = 0; round < 5; round++) {
          const response = await fetch(base + `/api/roster/enterprises/${id}`, { signal: AbortSignal.timeout(15000) })
          // Check the service after EVERY attempt, including an unsuccessful one.
          const body = await response.text()
          const health = await fetch(base + '/api/health'), list = await fetch(base + '/api/roster/enterprises')
          assert.equal(health.status, 200, output)
          assert.equal(list.status, 200, output)
          assert.equal((await list.json()).counts.total, 1)
          console.log(JSON.stringify({ heap, fresh, round, status: response.status, bodyBytes: Buffer.byteLength(body), health: health.status, list: list.status, cwdIndependent: true, execArgv }))
          assert.equal(response.status, 200, output)
          assert.equal(Buffer.byteLength(body), 100664296)
          const value = JSON.parse(body), raw = value.platform.relations[0].rawFields.original
          assert.equal(value.platform.relations.length, 1)
          assert.equal(value.platform.relations[0].enterpriseId, null)
          assert.equal(raw.length, size)
          assert.equal(createHash('sha256').update(raw).digest('hex'), expectedHash)
        }
        assert.doesNotMatch(output, /FATAL ERROR|worker_exited/)
      } finally { await stopOwnedChild(child) }
    }
  }
  console.log(JSON.stringify({ passed: true, expectedHash }))
} finally { rmSync(dir, { recursive: true, force: true }) }
