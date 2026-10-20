#!/usr/bin/env node
// Write only an already-copied private fixture, using the application's parser.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const [command, target, migration] = process.argv.slice(2)
const root = realpathSync('/tmp/ningbo-perf-83-90/workload') + sep
if (!['migrate-copy', 'scale2x'].includes(command) || !target || !realpathSync(target).startsWith(root)) {
  throw Error('existing owned private fixture and transform required')
}
const db = new Database(target, { fileMustExist: true })
try {
  db.pragma('foreign_keys = ON')
  if (command === 'migrate-copy') {
    // Do not fall back to Python SQLite: its JSON5 support can differ from the app.
    if (!migration) throw Error('explicit migration required')
    db.transaction(() => db.exec(readFileSync(resolve(migration), 'utf8')))()
  } else {
    const quote = value => `"${value.replaceAll('"', '""')}"`
    db.transaction(() => {
      const qmax = db.prepare('select max(id) n from platform_query').get().n ?? 0
      const rmax = db.prepare('select max(id) n from platform_relation').get().n ?? 0
      for (const table of ['platform_query', 'platform_relation']) {
        const columns = db.pragma(`table_info(${table})`).map(row => row.name)
        const expressions = columns.map(col => {
          if (col === 'id') return `${quote(col)} + ${table === 'platform_query' ? qmax : rmax}`
          if (col === 'query_id') return `${quote(col)} + ${qmax}`
          if (col === 'query_key') return `'spike90:synthetic-clone:' || ${quote(col)}`
          return quote(col)
        })
        db.exec(`insert into ${table} (${columns.map(quote).join(',')}) select ${expressions.join(',')} from ${table}`)
      }
    })()
  }
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw Error('fixture integrity failed')
  const sqliteVersion = db.prepare('select sqlite_version() version').get().version
  const helperSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  process.stdout.write(JSON.stringify({ driver: 'better-sqlite3', sqliteVersion, nodeVersion: process.version, helperSha256 }) + '\n')
} finally { db.close() }
