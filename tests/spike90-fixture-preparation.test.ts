import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

it('prepares JSON5 migration and 2x fixtures with the application SQLite authority without changing the source', () => {
  const root = '/tmp/ningbo-perf-83-90/workload'
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'test-authority-'))
  const source = join(dir, 'source.sqlite'), migrated = join(dir, 'migrated.sqlite'), doubled = join(dir, '2x.sqlite')
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  try {
    const db = new Database(source)
    const version = db.prepare('select sqlite_version() version').get() as { version: string }
    db.exec(`create table platform_query(id integer primary key, interface text, query_key text, rdjb text default '', title_code text, queried_at text, collection_evidence text, raw_response text);
      create table platform_relation(id integer primary key, query_id integer references platform_query(id), raw_fields text);
      insert into platform_query(id,interface,query_key,queried_at,collection_evidence,raw_response) values
      (1,'recognized_list','readable','2026-10-20','{titleScope:{rdjb:[''2'',],},}','original🙂'),
      (2,'recognized_list','bad','2026-10-20','{really malformed','original bad');
      insert into platform_relation values(1,1,'{"original":"原行"}');`)
    db.close()
    chmodSync(source, 0o400)
    const originalDigest = digest(source)
    const run = (command: string, input: string, output: string) => {
      const report = output + '.json'
      const args = ['run', 'python', 'scripts/spike-90/workload_control.py', command, '--source', input, '--output', output, '--report', report]
      if (command === 'migrate-copy') args.push('--migration', resolve('db/migrations/0027_platform_query_title_scope_83.sql'))
      const result = spawnSync('uv', args, { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } })
      expect(result.status, result.stderr).toBe(0)
      const proof = JSON.parse(readFileSync(report, 'utf8'))
      expect(proof.preparationAuthority).toMatchObject({ driver: 'better-sqlite3', sqliteVersion: version.version })
      expect(proof.preparationAuthority.helperSha256).toMatch(/^[a-f0-9]{64}$/)
      return proof
    }
    const proof = run('migrate-copy', source, migrated)
    expect(proof.before).toEqual(proof.after)
    expect(proof.migration_sha256).toBe(digest(resolve('db/migrations/0027_platform_query_title_scope_83.sql')))
    const copy = new Database(migrated, { readonly: true })
    expect(copy.prepare('select * from platform_query_title_scope').all()).toEqual([{ query_id: 1, rdjb: '2' }])
    expect(copy.prepare('select * from platform_query_title_scope_error').all()).toEqual([{ query_id: 2 }])
    copy.close()
    const scaled = run('scale2x', migrated, doubled)
    expect(scaled.after.platform_query.rows).toBe(4)
    expect(scaled.after.platform_relation.rows).toBe(2)
    expect(scaled.derived_after).toEqual({ platform_query_title_scope: 2, platform_query_title_scope_error: 2 })
    const two = new Database(doubled, { readonly: true })
    expect(two.prepare('select query_id,rdjb from platform_query_title_scope order by query_id').all()).toEqual([{ query_id: 1, rdjb: '2' }, { query_id: 3, rdjb: '2' }])
    expect(two.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(two.prepare('pragma foreign_key_check').all()).toEqual([])
    two.close()
    expect(digest(source)).toBe(originalDigest)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
