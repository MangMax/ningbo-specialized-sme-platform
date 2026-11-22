import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const root = fileURLToPath(new URL('../../..', import.meta.url))
type Runtime = Awaited<ReturnType<typeof postgresRuntimeFixture>>

function query(runtime: Runtime, sql: string, database?: string) {
  return runtime.psql(['-At', ...(database ? ['-d', database] : []), '-c', sql]).trim()
}

it.skipIf(!bin)('bootstraps the runtime catalog and seed data from an empty PostgreSQL database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-bootstrap-'))
  const runtimes: Runtime[] = []
  try {
    const native = await postgresRuntimeFixture({ dir, native: true })
    runtimes.push(native)
    expect(query(native, `SELECT nspname FROM pg_namespace
      WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','public') ORDER BY nspname`))
      .toBe('business\nruntime_logs')
    expect(query(native, "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'")).toBe('pg_trgm')
    expect(query(native, `SELECT column_name FROM information_schema.columns
      WHERE table_schema='runtime_logs' AND table_name='log_events' AND column_name IN ('detail','summary')`))
      .toBe('detail')
    expect(query(native, 'SELECT count(*) FROM business.platform_business_record')).toBe('0')
    expect(query(native, 'SELECT count(*) FROM runtime_logs.log_events')).toBe('0')

    const staged = await postgresRuntimeFixture({ dir, native: false })
    runtimes.push(staged)
    const catalog = [
      `SELECT table_schema, table_name, ordinal_position, column_name, data_type, is_nullable,
          column_default, collation_name, identity_generation, identity_start, identity_increment
        FROM information_schema.columns WHERE table_schema IN ('business', 'runtime_logs') ORDER BY 1, 2, 3`,
      `SELECT schemaname, tablename, indexname, indexdef
        FROM pg_indexes WHERE schemaname IN ('business', 'runtime_logs') ORDER BY 1, 2, 3`,
      `SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class c ON con.conrelid = c.oid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('business', 'runtime_logs') ORDER BY 1, 2, 3`,
      `SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('business', 'runtime_logs') AND NOT t.tgisinternal ORDER BY 1, 2, 3`,
    ]
    for (const sql of catalog) expect(query(native, sql)).toEqual(query(staged, sql))
    for (const [table, key] of [
      ['business.title', 'rank'],
      ['business.enterprise_kernel_completion', 'id'],
      ['business.enterprise_source_channel', 'code'],
      ['business.enterprise_source_list_type', 'code'],
      ['business.platform_legacy_alias_sequence', 'namespace'],
      ['runtime_logs.log_policy', 'id'],
      ['runtime_logs.log_collection', 'id'],
    ]) {
      const sql = `SELECT to_jsonb(t) FROM ${table} AS t ORDER BY ${key}`
      expect(query(native, sql)).not.toBe('')
      expect(query(native, sql)).toEqual(query(staged, sql))
    }
    expect(query(native, "INSERT INTO business.enterprise (name, name_norm) VALUES ('本地企业','本地企业') RETURNING id"))
      .toMatch(/^1\n/)
    expect(query(native, `INSERT INTO business.enterprise_alias (enterprise_id, name, name_norm, source_kind, created_at)
      VALUES (1, '旧名', '旧名', 'manual', '2026-11-22') RETURNING id`)).toMatch(/^1\n/)
    expect(query(native, 'SELECT alias_id FROM business.enterprise_former_name')).toBe('1')
  } finally {
    for (const runtime of runtimes.reverse()) runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

it.skipIf(!bin)('rolls back business creation when the target already owns a runtime log schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-bootstrap-conflict-'))
  let runtime: Runtime | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir, native: true, logsOnly: true })
    expect(query(runtime, "SELECT to_regnamespace('business') IS NULL")).toBe('t')
    const url = new URL(runtime.url)
    const retried = spawnSync(process.execPath, ['scripts/initialize-postgresql.mjs'], {
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
        PGHOST: url.searchParams.get('host')!,
        PGPORT: '5432',
        PGUSER: url.username,
        PGDATABASE: url.pathname.slice(1),
        PGSQL_BIN: join(bin!, 'psql'),
      },
      encoding: 'utf8',
    })
    expect(retried.status).not.toBe(0)
    expect(retried.stderr).toContain('schema "runtime_logs" already exists')
    expect(query(runtime, "SELECT to_regnamespace('business') IS NULL")).toBe('t')
    expect(query(runtime, 'SELECT revision FROM runtime_logs.log_collection')).toBe('0')
  } finally {
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)
