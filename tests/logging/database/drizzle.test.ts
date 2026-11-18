import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../../../layers/core/lib/logging/drizzle'

const { emit } = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('../../../layers/core/lib/logging/index', () => ({ appLog: emit }))
const connections: Database.Database[] = []
function fixture() {
  const client = new Database(':memory:')
  connections.push(client)
  client.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT UNIQUE)')
  return { client, db: drizzle(client, { logger: createDrizzleLogger({ connection: 'primary' }) }) }
}
afterEach(() => { emit.mockReset(); for (const client of connections.splice(0)) client.close() })

it('native run all get and values preserve results and report only pre-execution attempts', () => {
  const { client, db } = fixture()
  let rowsAtHook: unknown
  emit.mockImplementationOnce(() => {
    rowsAtHook = client.prepare('SELECT count(*) n FROM sample').get()
  })
  expect(db.run(sql`INSERT INTO sample(value) VALUES (${'PRIVATE_PARAM'})`)).toMatchObject({ changes: 1, lastInsertRowid: 1 })
  expect(rowsAtHook).toEqual({ n: 0 })
  expect(db.get(sql`SELECT value FROM sample`)).toEqual({ value: 'PRIVATE_PARAM' })
  expect(db.all(sql`SELECT id FROM sample`)).toEqual([{ id: 1 }])
  expect(db.values(sql`SELECT id FROM sample`)).toEqual([[1]])
  expect(emit.mock.calls.map(([event]) => event.operation)).toEqual(['db.query.insert', 'db.query.select', 'db.query.select', 'db.query.select'])
  for (const [event] of emit.mock.calls) expect(event).toEqual({
    source: 'system', operation: expect.stringMatching(/^db\.query\.(insert|select)$/), outcome: 'started', level: 'debug',
    resourceType: 'database_connection', resourceId: 'primary',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
  })
})

it.each([
  { name: 'select', statement: ' SeLeCt 1 /* PRIVATE_SQL */', verb: 'select' },
  { name: 'insert', statement: 'INSERT INTO sample(value) VALUES (\'PRIVATE_SQL\')', verb: 'insert' },
  { name: 'update', statement: 'UPDATE sample SET value=\'PRIVATE_SQL\'', verb: 'update' },
  { name: 'delete', statement: 'DELETE FROM sample WHERE value=\'PRIVATE_SQL\'', verb: 'delete' },
  { name: 'cte', statement: 'WITH value AS (SELECT 1) SELECT * FROM value', verb: 'other' },
  { name: 'comment', statement: '/* PRIVATE_SQL */ SELECT 1', verb: 'other' },
  { name: 'pragma', statement: 'PRAGMA user_version', verb: 'other' },
  { name: 'bounded-prefix', statement: ' '.repeat(40) + 'SELECT 1', verb: 'other' },
])('native query classifies the bounded first verb: $name', ({ statement, verb }) => {
  const { db } = fixture()
  db.run(sql.raw(statement))
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    source: 'system', operation: `db.query.${verb}`, outcome: 'started', level: 'debug',
    resourceType: 'database_connection', resourceId: 'primary',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
  }, undefined)
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PRIVATE|sample|params|durationMs/)
})

it('native execution failure preserves the original thrown object with no invented completion', () => {
  const { client, db } = fixture()
  const fault = new Error('PRIVATE_NATIVE_ERROR')
  client.function('fail_query', () => { throw fault })
  let observed: unknown
  try { db.get(sql`SELECT fail_query()`) } catch (error) { observed = error }
  expect(observed).toBe(fault)
  expect(emit).toHaveBeenCalledTimes(1)
  expect(emit.mock.calls[0]![0]).toMatchObject({ operation: 'db.query.select', outcome: 'started', level: 'debug' })
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PRIVATE|failure|success|durationMs|error|stack/)
})

it('preparation and missing-placeholder failures never fabricate a hook observation', () => {
  const { db } = fixture()
  expect(() => db.get(sql`SELECT * FROM PRIVATE_MISSING_TABLE`)).toThrow()
  expect(() => db.get(sql`SELECT ${sql.placeholder('PRIVATE_PLACEHOLDER')}`)).toThrow()
  expect(emit).not.toHaveBeenCalled()
})

it('throwing diagnostic callbacks preserve native return error and transaction rollback semantics', () => {
  const { client, db } = fixture()
  emit.mockImplementation(() => { throw new Error('PRIVATE_LOGGER_FAILURE') })
  expect(db.run(sql`INSERT INTO sample(value) VALUES (${'kept'})`)).toMatchObject({ changes: 1 })
  expect(db.get(sql`SELECT value FROM sample`)).toEqual({ value: 'kept' })
  const fault = new Error('PRIVATE_NATIVE_FAILURE')
  client.function('fail_query', () => { throw fault })
  let observed: unknown
  try { db.get(sql`SELECT fail_query()`) } catch (error) { observed = error }
  expect(observed).toBe(fault)
  expect(() => db.transaction(tx => {
    tx.run(sql`INSERT INTO sample(value) VALUES (${'rolled-back'})`)
    throw fault
  })).toThrow(fault)
  expect(db.all(sql`SELECT value FROM sample`)).toEqual([{ value: 'kept' }])
})

it('worker hook uses only explicitly supplied execution and correlation context', () => {
  const { client } = fixture()
  const context = { requestId: 'drizzle-worker-request', traceId: 'drizzle-worker-trace' }
  const db = drizzle(client, { logger: createDrizzleLogger({ connection: 'enterprise_read', execution: 'worker', context }) })
  expect(db.get(sql`SELECT 42 value`)).toEqual({ value: 42 })
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug',
    resourceType: 'database_connection', resourceId: 'enterprise_read',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook', execution: 'worker' },
  }, context)
})
