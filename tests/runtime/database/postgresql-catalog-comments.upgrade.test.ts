import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
type Runtime = Awaited<ReturnType<typeof postgresRuntimeFixture>>
const schemas = "('business','runtime_logs')"
const tableComments = `SELECT md5(string_agg(coalesce(obj_description(c.oid,'pg_class'),''), '|' ORDER BY n.nspname, c.relname))
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ${schemas} AND c.relkind='r'`

function query(runtime: Runtime, sql: string) {
  return runtime.psql(['-At', '-c', sql]).trim()
}

it.skipIf(!bin)('reapplies the catalog comment upgrade to an existing database without drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-catalog-comment-upgrade-'))
  let runtime: Runtime | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    const tableCount = query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r'`)
    query(runtime, `DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname IN ${schemas} AND c.relkind='r' LOOP
          EXECUTE format('COMMENT ON TABLE %I.%I IS NULL', r.nspname, r.relname);
        END LOOP;
        FOR r IN SELECT table_schema, table_name, column_name FROM information_schema.columns
                 WHERE table_schema IN ${schemas} LOOP
          EXECUTE format('COMMENT ON COLUMN %I.%I.%I IS NULL', r.table_schema, r.table_name, r.column_name);
        END LOOP;
      END $$;`)
    expect(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r' AND obj_description(c.oid,'pg_class') IS NOT NULL`)).toBe('0')

    runtime.psql(['-f', 'upgrade/pg/2026-11-catalog-comments/apply.sql'])
    const first = query(runtime, tableComments)
    runtime.psql(['-f', 'upgrade/pg/2026-11-catalog-comments/apply.sql'])
    const second = query(runtime, tableComments)

    expect(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r'
        AND (obj_description(c.oid,'pg_class') IS NULL OR obj_description(c.oid,'pg_class')='')`)).toBe('0')
    expect(query(runtime, `SELECT count(*) FROM information_schema.columns c
      WHERE c.table_schema IN ${schemas}
        AND col_description((quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass, c.ordinal_position) IS NULL`)).toBe('0')
    expect(query(runtime, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ${schemas} AND c.relkind='r' AND obj_description(c.oid,'pg_class') IS NOT NULL`)).toBe(tableCount)
    expect(second).toBe(first)
  } finally {
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
