import Database from 'better-sqlite3'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/bench-correspondence-reads.mjs')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
  }
})
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'correspondence-cli-582-'))
  dirs.push(dir)
  return dir
}
function cli(action: string, db: string, scale = '1', rounds = '1', sourceRoot = root) {
  const result = spawnSync(process.execPath, [script, action, db, scale, sourceRoot, '1', rounds], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 20 * 1024 * 1024,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  return result
}
function prepare(scale = '1') {
  const db = join(temporary(), 'synthetic.db')
  const result = cli('prepare', db, scale)
  expect(result.status, result.stderr).toBe(0)
  return db
}
it('rejects a real 1x synthetic database labelled as scale 5', () => {
  const db = prepare()
  const result = cli('read', db, '5')
  expect(result.status, result.stdout).not.toBe(0)
  expect(result.stderr).toMatch(/synthetic.*scale/i)
}, 30000)

it.each([
  ['deleted audit row', 'DELETE FROM record_correspondence_audit WHERE id = 500'],
  ['deleted deep row', 'DELETE FROM record_correspondence WHERE id = 300'],
  ['moved deep row', 'UPDATE record_correspondence SET id = 1001 WHERE id = 300'],
  ['changed audit revision', 'UPDATE record_correspondence_audit SET resulting_revision = 999 WHERE id = 400'],
  ['changed ID1 event binding', 'UPDATE record_correspondence SET event_id = 2 WHERE id = 1'],
  ['changed ID1 relation binding', 'UPDATE record_correspondence SET relation_id = 2 WHERE id = 1'],
])('rejects %s on real SQLite', (_name, sql) => {
  const db = prepare()
  const connection = new Database(db)
  try { connection.exec(sql) } finally { connection.close() }
  const result = cli('read', db)
  expect(result.status, result.stdout).not.toBe(0)
  expect(result.stderr).toMatch(/synthetic|oracle/)
  // SQLite readonly WAL sidecars are input companions, not owned temporary files.
  // The fixture owner checkpoints after the CLI has released its connection.
  const owner = new Database(db)
  try { expect(owner.pragma('wal_checkpoint(TRUNCATE)')).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]) } finally { owner.close() }
  expect(readdirSync(resolve(db, '..')).sort()).toEqual(['synthetic.db', 'synthetic.db.synthetic.json'])
}, 30000)

it.each(['0', '-1', 'NaN', '1.5', 'Infinity', '9007199254740992'])('rejects rounds %s before touching the database', rounds => {
  const dir = temporary(), db = join(dir, 'absent.db')
  const result = cli('read', db, '1', rounds)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('rounds must be a finite positive safe integer')
  expect(readdirSync(dir)).toEqual([])
})

it.each(['1', '2'])('verifies literal pages and partial unknown semantics for real scale %s', scale => {
  const db = prepare(scale), result = cli('read', db, scale, '2')
  expect(result.status, result.stderr).toBe(0)
  const rows = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  expect(rows.map(row => row.mode)).toEqual(['list', 'deep', 'point', 'event', 'audit', 'candidates'])
  expect(rows.every(row => row.samples === 2)).toBe(true)
  expect(rows.find(row => row.mode === 'deep').verified).toEqual({ total: scale === '1' ? 400 : 800, ids: [300] })
  expect(rows.find(row => row.mode === 'audit').verified).toEqual({ total: scale === '1' ? 500 : 1000, ids: [400], revisions: [[399, 400]] })
  expect(rows.find(row => row.mode === 'point').verified).toEqual({ ids: [1], eventIds: [1], relationIds: [1], queryStatus: 'partial' })
  expect(rows.find(row => row.mode === 'candidates').verified).toEqual({ total: 1, relationIds: [1], coverage: ['partial'], groupState: 'not_indexed', processKind: 'apply', processStatus: null, relationYear: 2022, relationBatch: null })
}, 30000)

it('refuses an existing prepare path and preserves every original byte', () => {
  const dir = temporary(), db = join(dir, 'existing.db'), bytes = Buffer.from('caller-owned bytes\0unchanged')
  writeFileSync(db, bytes)
  const result = cli('prepare', db)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('prepare requires a new isolated synthetic DB')
  expect(readFileSync(db)).toEqual(bytes)
  expect(readdirSync(dir)).toEqual(['existing.db'])
})

it('refuses unverified input without creating a database', () => {
  const dir = temporary(), db = join(dir, 'unverified.db')
  const result = cli('read', db)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('unverified input')
  expect(readdirSync(dir)).toEqual([])
})

// Pure CLI control-flow lane: no SQLite or product adapter behavior is claimed.
function injected(mode: 'empty' | 'throw' | 'prepare-failure') {
  const dir = temporary(), db = join(dir, 'synthetic.db')
  mkdirSync(join(dir, 'db'))
  mkdirSync(join(dir, 'server/utils'), { recursive: true })
  writeFileSync(db, 'control-flow stand-in, not SQLite')
  writeFileSync(db + '.synthetic.json', JSON.stringify({ version: 'correspondence-85-v1', scale: 1 }))
  writeFileSync(join(dir, 'db/client.ts'), `
    import { writeFileSync } from 'node:fs'
    export const schema = {}
    export function useDb() { return {
      transaction() { throw new Error('injected prepare failure') },
      $client: { open: true,
        prepare(sql) { return { get: () => ({ n: sql.includes('audit') ? 500 : 400 }), all: () => [{ name: 'synthetic', name_norm: 'synthetic' }] } },
        close() { this.open = false; writeFileSync(${JSON.stringify(join(dir, 'closed'))}, 'closed') }
      }
    } }
  `)
  writeFileSync(join(dir, 'server/utils/record-correspondence-api.ts'), mode === 'throw'
    ? `export function handleRecordCorrespondenceRequest() { throw new Error('injected handler failure') }`
    : `export function handleRecordCorrespondenceRequest() { return { status: 200, headers: { 'cache-control': 'no-store' }, body: { rows: [], total: 0 } } }`)
  writeFileSync(join(dir, 'server/utils/mcp-record-correspondence.ts'), `export function dispatchRecordCorrespondenceMcp() { return { rows: [], total: 0 } }`)
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-c', 'user.name=CLI fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'control-flow fixture'], { cwd: dir })
  return { dir, db }
}
it('rejects both adapters returning the same empty page and closes resources (control-flow injection)', () => {
  const { dir, db } = injected('empty')
  const result = cli('read', db, '1', '1', dir)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('synthetic oracle: list')
  expect(readFileSync(join(dir, 'closed'), 'utf8')).toBe('closed')
})
it('closes resources and exits nonzero after a throwing handler (control-flow injection)', () => {
  const { dir, db } = injected('throw')
  const result = cli('read', db, '1', '1', dir)
  expect(result.status).not.toBe(0)
  expect(readFileSync(join(dir, 'closed'), 'utf8')).toBe('closed')
})
it('removes only its new database after prepare failure (control-flow injection)', () => {
  const { dir, db } = injected('prepare-failure')
  rmSync(db)
  rmSync(db + '.synthetic.json')
  const result = cli('prepare', db, '1', '1', dir)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('injected prepare failure')
  expect(readFileSync(join(dir, 'closed'), 'utf8')).toBe('closed')
  for (const suffix of ['', '-wal', '-shm', '.synthetic.json']) expect(existsSync(db + suffix)).toBe(false)
})

it('checks real counts even when the manifest is relabelled', () => {
  const db = prepare()
  writeFileSync(db + '.synthetic.json', JSON.stringify({ version: 'correspondence-85-v1', scale: 5 }))
  const result = cli('read', db, '5')
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('synthetic correspondence count')
}, 30000)
it('rejects an unsupported synthetic version before opening the file', () => {
  const dir = temporary(), db = join(dir, 'absent.db')
  writeFileSync(db + '.synthetic.json', JSON.stringify({ version: 'unverified', scale: 1 }))
  const result = cli('read', db)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('unverified synthetic fixture version')
  expect(existsSync(db)).toBe(false)
})


it.each(['-wal', '-shm'])('preserves a pre-existing prepare companion %s', suffix => {
  const dir = temporary(), db = join(dir, 'synthetic.db'), bytes = Buffer.from('other owner companion')
  writeFileSync(db + suffix, bytes)
  const result = cli('prepare', db)
  expect(result.status).not.toBe(0)
  expect(readFileSync(db + suffix)).toEqual(bytes)
  expect(readdirSync(dir)).toEqual(['synthetic.db' + suffix])
})

it('preserves a destination replaced during failed preparation (filesystem interleaving)', () => {
  const { dir, db } = injected('prepare-failure')
  rmSync(db)
  rmSync(db + '.synthetic.json')
  writeFileSync(join(dir, 'db/client.ts'), `
    import { existsSync, renameSync, writeFileSync } from 'node:fs'
    export const schema = {}
    export function useDb() {
      const destination = ${JSON.stringify(db)};
      if (existsSync(destination)) renameSync(destination, destination + '.reserved');
      writeFileSync(destination, 'replacement belongs to another owner');
      throw new Error('injected failure after destination replacement');
    }
  `)
  const result = cli('prepare', db, '1', '1', dir)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('injected failure after destination replacement')
  expect(readFileSync(db, 'utf8')).toBe('replacement belongs to another owner')
  expect(readdirSync(dir).filter(name => name.startsWith('.correspondence-prepare-'))).toEqual([])
})


it.each(['database', 'manifest'])('preserves a competing %s at exclusive publication (filesystem interleaving)', target => {
  const dir = temporary(), db = join(dir, 'synthetic.db'), hook = join(dir, 'publication-hook.cjs')
  const competing = target === 'database' ? db : db + '.synthetic.json'
  writeFileSync(hook, `
    const fs = require('node:fs');
    const original = fs.linkSync;
    fs.linkSync = function(source, destination, ...args) {
      if (destination === ${JSON.stringify(competing)}) fs.writeFileSync(destination, 'competing owner bytes', {flag:'wx'});
      return original.call(this, source, destination, ...args);
    };
    require('node:module').syncBuiltinESMExports();
  `)
  const result = spawnSync(process.execPath, ['--require', hook, script, 'prepare', db, '1', root], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 20 * 1024 * 1024,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('EEXIST')
  expect(readFileSync(competing, 'utf8')).toBe('competing owner bytes')
  expect(readdirSync(dir).filter(name => name.startsWith('.correspondence-prepare-'))).toEqual([])
  if (target === 'manifest') {
    expect(result.stderr).toContain('destination paths were preserved for inspection')
    const preserved = new Database(db, {readonly:true})
    try { expect(preserved.prepare('SELECT count(*) AS n FROM record_correspondence').get()).toEqual({n:400}) } finally {preserved.close()}
  } else expect(existsSync(db + '.synthetic.json')).toBe(false)
}, 30000)
