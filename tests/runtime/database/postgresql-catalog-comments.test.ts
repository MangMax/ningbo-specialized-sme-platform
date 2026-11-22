import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
type Runtime = Awaited<ReturnType<typeof postgresRuntimeFixture>>
const schemas = "('business','runtime_logs')"

function query(runtime: Runtime, sql: string) {
  return runtime.psql(['-At', '-c', sql]).trim()
}

it.skipIf(!bin)('documents every business and runtime_logs table and column in Chinese', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-catalog-comments-'))
  let runtime: Runtime | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    expect(Number(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r'`))).toBeGreaterThan(0)
    expect(Number(query(runtime, `SELECT count(*) FROM information_schema.columns
      WHERE table_schema IN ${schemas}`))).toBeGreaterThan(0)
    expect(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r'
        AND (obj_description(c.oid,'pg_class') IS NULL OR obj_description(c.oid,'pg_class')='')`)).toBe('0')
    expect(query(runtime, `SELECT count(*) FROM information_schema.columns c
      WHERE c.table_schema IN ${schemas}
        AND col_description((quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass, c.ordinal_position) IS NULL`)).toBe('0')
    expect(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r'
        AND obj_description(c.oid,'pg_class') !~ '[一-龥]'`)).toBe('0')
  } finally {
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
