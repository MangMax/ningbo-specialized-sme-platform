#!/usr/bin/env node
// Separate source-driver attribution, not compiled HTTP or OS-cold evidence.
// node --experimental-transform-types scripts/bench-discovery-connection227.mjs SOURCE_ROOT PRIVATE_CLONE MATRIX CELL NEW_REPORT
import assert from 'node:assert/strict'
import { register, createRequire } from 'node:module'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
const [rootText, dbPath, matrixPath, name, report] = process.argv.slice(2)
const root = resolve(rootText)
assert.ok(!existsSync(report), 'preserve evidence')
for (const k of Object.keys(process.env)) if (/TOKEN|COOKIE|PASSWORD|SECRET/.test(k)) delete process.env[k]
process.env.NUXT_DB_PATH = dbPath; process.env.NUXT_DB_READONLY = '1'
Object.assign(globalThis, { useRuntimeConfig: () => ({ apiToken: 'synthetic-perf227-only', mcpToken: '', miitCookie: '', ocrToken: '' }) })
register(root + '/scripts/perf-82/loader.mjs', import.meta.url)
const require = createRequire(root + '/package.json')
const Database = require('better-sqlite3')
const { readFileSync } = await import('node:fs')
const cell = JSON.parse(readFileSync(matrixPath)).cells.find(c => c.name === name)
assert.ok(cell?.discovery && cell.method === 'POST')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const hash = body => createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
let phase = 'imports', records = [], plans = new Map(), capturePlans = false
const original = Database.prototype.prepare
Database.prototype.prepare = function (sql) {
  const statement = original.call(this, sql)
  for (const op of ['all', 'get', 'run']) {
    const invoke = statement[op]
    statement[op] = function (...args) {
      const start = performance.now()
      try { return invoke.apply(this, args) } finally {
        records.push({ phase, op, ms: performance.now() - start, sql })
        // Plans are a separate, unmeasured replay; never mixed into timed API wall.
        if (capturePlans && /^select\s/i.test(sql) && !plans.has(sql)) {
          try { plans.set(sql, original.call(this.database, 'EXPLAIN QUERY PLAN ' + sql).all(...args)) }
          catch (error) { plans.set(sql, { error: String(error) }) }
        }
      }
    }
  }
  return statement
}
let t = performance.now()
const { useDb } = await import(root + '/db/client.ts')
const { handleRecordCorrespondenceRequest: api } = await import(root + '/server/utils/record-correspondence-api.ts')
const { dispatchRecordCorrespondenceMcp: mcp } = await import(root + '/server/utils/mcp-record-correspondence.ts')
const { drizzle } = await import('file://' + require.resolve('drizzle-orm/better-sqlite3'))
const schema = await import(root + '/db/schema.ts')
const importsMs = performance.now() - t
phase = 'open-first'; t = performance.now(); const firstDb = useDb({ dbPath, readOnly: true }); const firstOpenMs = performance.now() - t
const run = (db, label) => {
  phase = label; const usage = process.resourceUsage(), cpu = process.cpuUsage(), memoryBefore = process.memoryUsage(), start = performance.now()
  const result = api({ action: 'discover', method: 'POST', body: cell.args }, { db })
  const apiMs = performance.now() - start, serializationStart = performance.now(), bytes = Buffer.byteLength(JSON.stringify(result.body)), stringifyMs = performance.now() - serializationStart
  const usageEnd = process.resourceUsage()
  return { label, status: result.status, apiMs, stringifyMs, bytes, canonicalSha256: hash(result.body), total: result.body?.total, queryTotal: result.body?.coverage?.total, memoryBefore, memoryAfter: process.memoryUsage(), cpu: process.cpuUsage(cpu), usageDelta: Object.fromEntries(Object.keys(usage).map(k => [k, usageEnd[k] - usage[k]])) }
}
const fresh = run(firstDb, 'fresh-process-first-api'), warm = run(firstDb, 'same-connection-warm')
firstDb.$client.close()
phase = 'new-connection-open'; t = performance.now()
const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true }); sqlite.pragma('foreign_keys=ON')
const newDb = drizzle(sqlite, { schema }), newConnectionOpenMs = performance.now() - t
const reopened = run(newDb, 'same-process-new-connection-first-api')
phase = 'mcp-parity'; t = performance.now(); const parity = mcp('discover', cell.args, { db: newDb }); const mcpMs = performance.now() - t
capturePlans = true; run(newDb, 'plans-unmeasured'); sqlite.close()
const out = { cell: name, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), importsMs, firstOpenMs, newConnectionOpenMs, fresh, warm, reopened, mcpMs, parityEqual: hash(parity) === fresh.canonicalSha256, records, plans: [...plans].map(([sql, plan]) => ({ sql, plan })), label: 'new Node process + readonly connection vs reopened readonly connection in same process; OS cache not purged; source loader, not compiled Nitro' }
writeFileSync(report, JSON.stringify(out, null, 2), { flag: 'wx', mode: 0o600 })
assert.equal(fresh.status, 200); assert.equal(reopened.status, 200)
assert.equal(fresh.canonicalSha256, warm.canonicalSha256); assert.equal(fresh.canonicalSha256, reopened.canonicalSha256); assert.ok(out.parityEqual)
console.log(JSON.stringify({ cell: name, freshMs: fresh.apiMs, reopenedMs: reopened.apiMs, parityEqual: out.parityEqual }))
