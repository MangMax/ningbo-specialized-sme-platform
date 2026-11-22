import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
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

it.skipIf(!bin)('keeps historical public IDs and allocates fresh IDs above both prior high water marks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-public-id-upgrade-'))
  let runtime: Runtime | undefined
  let pool: pg.Pool | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    query(runtime, `SET search_path TO business, pg_catalog;
      DROP TRIGGER platform_collection_public_id_fixed ON platform_collection;
      DROP TRIGGER platform_collection_public_id_retained ON platform_collection;
      DROP TRIGGER platform_observation_public_id_fixed ON platform_business_observation;
      DROP TRIGGER platform_observation_public_id_retained ON platform_business_observation;
      ALTER TABLE platform_collection DROP COLUMN public_id;
      ALTER TABLE platform_business_observation DROP COLUMN public_id;
      CREATE TABLE platform_legacy_query_alias (
        old_id bigint PRIMARY KEY, collection_id bigint NOT NULL UNIQUE REFERENCES platform_collection(id)
      );
      CREATE TABLE platform_legacy_relation_alias (
        old_id bigint PRIMARY KEY, observation_id bigint NOT NULL UNIQUE REFERENCES platform_business_observation(id)
      );
      CREATE TABLE platform_legacy_alias_sequence (namespace text PRIMARY KEY, high_water bigint NOT NULL);
      INSERT INTO platform_legacy_alias_sequence VALUES ('query',1200),('relation',500);
      INSERT INTO platform_collection (interface, query_key, rdjb, queried_at, created_at, status,
        completeness, provenance_state, parse_state, rule_version)
        VALUES ('recognized_list','historic','2','2024-06-01','2024-06-01','success','complete','captured','valid','fixture');
      INSERT INTO platform_business_observation (collection_id,sequence_no,source_relation_key,
        identity_state,content_state,position_state)
        VALUES (1,1,'historic','not_indexed','not_indexed','unknown');
      INSERT INTO platform_legacy_query_alias VALUES (900,1);
      INSERT INTO platform_legacy_relation_alias VALUES (700,1);
      INSERT INTO platform_observation_assignment (observation_id,revision,match_basis,verification_status,origin)
        VALUES (1,1,'none','pending','migrated_current');`)
    const installer = 'upgrade/pg/2026-11-data-compaction/steps/03-install-platform-public-ids.sql'
    runtime.psql(['-f', installer])
    runtime.psql(['-f', installer])

    const url = new URL(runtime.url)
    pool = new pg.Pool({ host: url.searchParams.get('host')!, user: url.username, database: 'postgres',
      options: '-c search_path=business,pg_catalog' })
    const existing = await pool.query(`SELECT c.id AS collection_id,c.public_id AS query_id,
      o.id AS observation_id,o.public_id AS relation_id,a.observation_id AS assignment_owner
      FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id
      JOIN platform_observation_assignment a ON a.observation_id=o.id WHERE c.public_id=900 AND o.public_id=700`)
    expect(existing.rows).toEqual([{ collection_id: '1', query_id: '900', observation_id: '1', relation_id: '700', assignment_owner: '1' }])
    expect(query(runtime, "SELECT count(*) FROM pg_tables WHERE schemaname='business' AND tablename LIKE 'platform_legacy_%'")).toBe('0')

    const writer = (key: string) => pool!.query<{ query_id: string; relation_id: string; collection_id: string; observation_id: string }>(`
      WITH collection AS (
        INSERT INTO platform_collection (interface, query_key, rdjb, queried_at, created_at, status,
          completeness, provenance_state, parse_state, rule_version)
        VALUES ('recognized_list',$1,'2','2026-01-01','2026-01-01','success','complete','captured','valid','fixture')
        RETURNING id, public_id
      ), observation AS (
        INSERT INTO platform_business_observation (collection_id,sequence_no,source_relation_key,
          identity_state,content_state,position_state)
        SELECT id,1,$1,'not_indexed','not_indexed','unknown' FROM collection
        RETURNING id,collection_id,public_id
      )
      SELECT c.id AS collection_id,c.public_id AS query_id,o.id AS observation_id,o.public_id AS relation_id
      FROM collection c JOIN observation o ON o.collection_id=c.id`, [key])
    const rows = (await Promise.all([writer('first'), writer('second')])).flatMap(result => result.rows)
    expect(rows.map(row => row.query_id).sort()).toEqual(['1201', '1202'])
    expect(rows.map(row => row.relation_id).sort()).toEqual(['701', '702'])
    expect(rows.map(row => row.collection_id).sort()).toEqual(['2', '3'])
    expect(rows.map(row => row.observation_id).sort()).toEqual(['2', '3'])
    await expect(pool.query('UPDATE platform_collection SET public_id=901 WHERE public_id=900')).rejects.toThrow('append-only')
    await expect(pool.query('UPDATE platform_collection SET id=901 WHERE public_id=1201')).rejects.toThrow('append-only')
    await expect(pool.query('UPDATE platform_business_observation SET public_id=701 WHERE public_id=700')).rejects.toThrow('append-only')
  } finally {
    try { await pool?.end() }
    finally {
      runtime?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 20_000)
