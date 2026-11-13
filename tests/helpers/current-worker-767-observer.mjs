// Test-only OS child observation. Run with NODE_OPTIONS=--import <this file>.
// The business reader, transaction, SQLite statements and IPC encoder are real.
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'

const RealDate = Date
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [Date.parse('2026-12-01T00:00:00Z')])) }
  static now() { return RealDate.parse('2026-12-01T00:00:00Z') }
}

const Database = createRequire(import.meta.url)('better-sqlite3')
const prepare = Database.prototype.prepare
let observed = false
Database.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql)
  const release = process.env.CURRENT767_BARRIER
  if (!observed && release && sql === 'select id,name,name_norm,uscc_norm,district,city from enterprise where id=?') {
    const get = statement.get
    statement.get = function (...params) {
      if (!observed && params[0] === 760) {
        observed = true
        writeFileSync(release + '.ready', 'snapshot')
        const deadline = performance.now() + 15000
        while (!existsSync(release)) {
          if (performance.now() > deadline) throw new Error('767 real SQL barrier deadline')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        }
      }
      return get.apply(this, params)
    }
  }
  return statement
}
