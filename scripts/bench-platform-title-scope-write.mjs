#!/usr/bin/env node
// Synthetic transaction cost for #83. Creates only temporary databases outside Git.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const dir = mkdtempSync(join(tmpdir(), 'platform-title-write-'))
try {
  const folder = resolve('db/migrations')
  const beforeFolder = join(dir, 'before-83')
  mkdirSync(join(beforeFolder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
  const old = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 24) }
  writeFileSync(join(beforeFolder, 'meta/_journal.json'), JSON.stringify(old))
  for (const entry of old.entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(beforeFolder, `${entry.tag}.sql`))
  const paths = { before: join(dir, 'before.sqlite'), after: join(dir, 'after.sqlite') }
  const dbs = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, new Database(path)]))
  try {
    for (const db of Object.values(dbs)) {
      db.pragma('foreign_keys=ON')
      migrate(drizzle(db), { migrationsFolder: beforeFolder })
    }
    migrate(drizzle(dbs.after), { migrationsFolder: folder })
    const payloads = [JSON.stringify({ titleScope: { rdjb: ['1', '2'] } }), JSON.stringify({ titleScope: { rdjb: ['2', '3'] } })]
    const probes = Object.fromEntries(Object.entries(dbs).map(([name, db]) => [name, {
      db,
      insert: db.prepare('insert into platform_query(interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) values(?,?,?,?,?,?,?)'),
      update: db.prepare('update platform_query set collection_evidence = ? where id = ?'),
      remove: db.prepare('delete from platform_query where id = ?'),
    }]))
    const rounds = []
    for (let round = 0; round < 7; round++) {
      for (const name of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        const { db, insert, update, remove } = probes[name]
        const ids = []
        const started = performance.now()
        db.exec('begin immediate')
        try {
          for (let i = 0; i < 300; i++) {
            const result = insert.run('recognized_list', `synthetic:83:${round}:${i}`, '', '2026-10-20', 'success', payloads[0], '2026-10-20')
            ids.push(Number(result.lastInsertRowid))
          }
          const insertedMs = performance.now() - started
          for (const id of ids) update.run(payloads[1], id)
          const updatedMs = performance.now() - started - insertedMs
          for (const id of ids.slice(0, 150)) remove.run(id)
          const deletedMs = performance.now() - started - insertedMs - updatedMs
          if (name === 'after') {
            assert.equal(db.prepare('select count(*) n from platform_query_title_scope').get().n, 300)
            assert.equal(db.prepare('select count(*) n from platform_query_title_scope_error').get().n, 0)
          }
          db.exec('rollback')
          assert.equal(db.prepare('select count(*) n from platform_query').get().n, 0)
          if (name === 'after') assert.equal(db.prepare('select count(*) n from platform_query_title_scope').get().n, 0)
          rounds.push({ round, name, insertedMs, updatedMs, deletedMs, writeMs: insertedMs + updatedMs + deletedMs })
        } catch (error) { db.exec('rollback'); throw error }
      }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const summary = Object.fromEntries(['before', 'after'].map(name => [name, Object.fromEntries(['insertedMs', 'updatedMs', 'deletedMs', 'writeMs'].map(field => [field, median(rounds.filter(row => row.name === name).map(row => row[field]))]))]))
    console.log(JSON.stringify({ workload: '300 inserts, 300 archive updates, 150 deletes per rollback-only transaction; 7 rounds; synthetic SQLite', summary, rounds }))
  } finally { for (const db of Object.values(dbs)) db.close() }
} finally { rmSync(dir, { recursive: true, force: true }) }
