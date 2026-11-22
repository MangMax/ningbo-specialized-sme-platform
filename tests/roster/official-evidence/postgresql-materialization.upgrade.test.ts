import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { nativeCatalogFixture } from '../../platform/fixtures/native-catalog'

const connection = process.env.TEST_ROSTER_PG19_DATABASE

test.runIf(Boolean(connection))('loads linked roster facts, keeps platform bytes offline and rejects replay', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'roster-materialization-'))
  const suffix = randomUUID().replaceAll('-', '')
  const staging = 'roster_stage_' + suffix
  const target = 'roster_test_' + suffix
  const failedTarget = target + '_failed'
  const snapshot = join(workspace, 'snapshot.sqlite')
  const psql = process.env.PGSQL_BIN ?? 'psql'
  const env = { ...process.env, PGDATABASE: connection }
  const command = ['-X', '-w', '-Atq', '-v', 'ON_ERROR_STOP=1']
  const query = (sql: string) => execFileSync(psql, [...command, '-c', sql], { env, encoding: 'utf8' }).trim()
  const materialize = (schema = target) => spawnSync(psql, [...command, '-v', `staging=${staging}`, '-v', `target=${schema}`,
    '-f', 'upgrade/postgresql/materialize-roster.sql'], { env, encoding: 'utf8' })

  try {
    const sqlite = new Database(snapshot)
    try {
      createRuntimeSchema(sqlite)
      sqlite.exec(`
        INSERT INTO enterprise(id,name,name_norm) VALUES (7,'企业甲','企业甲');
        INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at)
          VALUES (9,'notice.pdf','notice.pdf','pdf',2,'fixture','2025-01-01');
        INSERT INTO roster_file_classification(file_id,source,year,title_code)
          VALUES (9,'jxj',2024,'specialized_sme');
        INSERT INTO record(id,enterprise_id,title_code,source) VALUES (17,7,'specialized_sme','jxj');
        INSERT INTO record_event(id,record_id,event_type,year) VALUES (29,17,'award',2024);
        INSERT INTO record_evidence(id,record_event_id,source_file,attachment,list_no)
          VALUES (37,29,'notice.pdf',' 附件一 ',3);
        INSERT INTO roster_legacy_member(enterprise_id) VALUES (7);
        UPDATE sqlite_sequence SET seq=70.5 WHERE name='record_evidence';
        INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,
          status,completeness,provenance_state,parse_state,rule_version)
          VALUES (41,'recognized_list','企业甲','','2025-01-01','2025-01-01',
            'success','complete','captured','valid','fixture');
        INSERT INTO platform_legacy_query_alias(old_id,collection_id) VALUES (42,41);
        INSERT INTO platform_collection_condition(collection_id,name,value_kind)
          VALUES (41,'rddqrq','absent');
        INSERT INTO platform_collection_condition(collection_id,name,value_kind,text_value)
          VALUES (41,'combination','text','and');
        INSERT INTO platform_collection_unfinished(collection_id,ordinal,source,rdjb,page_no)
          VALUES (41,8,'queryBusList','3',2), (41,2,'queryBusList','2',NULL);
        UPDATE platform_collection_condition SET witness_kind='text', witness_value=' 01 '
          WHERE collection_id=41 AND name='rddqrq';
      `)
      sqlite.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,status,created_at) VALUES(59,'raw-capture','announcement','fixture','committed','2025-01-01')")
      sqlite.prepare(`INSERT INTO official_evidence_row_revision(
        evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,name_raw,uscc_raw,district_raw,
        source_binding_known,actor,basis,command_kind,import_batch_id,created_at
      ) VALUES(37,1,29,17,7,?,?,?,0,'{"type":"agent","id":"fixture"}','literal source','import',59,'2025-01-01')`)
        .run('公布名' + String.fromCharCode(0) + '🙂', ' 原统代 ', null)
      const bytes = Buffer.from('00ff0d0a', 'hex')
      sqlite.prepare("INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES (47,'blob',?,?,?)")
        .run(bytes, bytes.length, createHash('sha256').update(bytes).digest('hex'))
      sqlite.exec(`
        INSERT INTO platform_collection_archive_ref(owner_id,field,archive_id,sealed)
          VALUES (41,'rawResponse',47,1);
      `)
    } finally {
      sqlite.close()
    }
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', snapshot, staging], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const createCore = (schema: string) => query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.enterprise(id bigint PRIMARY KEY);
      CREATE TABLE ${schema}.enterprise_merge(from_enterprise_id bigint, into_enterprise_id bigint);
      CREATE TABLE ${schema}.stored_file(id bigint PRIMARY KEY);
      INSERT INTO ${schema}.enterprise VALUES (7), (8);
      INSERT INTO ${schema}.stored_file VALUES (9);`)
    createCore(target)

    const first = materialize()
    expect(first.stderr).toBe('')
    expect(first.status).toBe(0)
    expect(query(`SELECT r.enterprise_id,r.id,e.id,e.year,v.id,v.attachment,c.file_id
      FROM ${target}.record r JOIN ${target}.record_event e ON e.record_id=r.id
      JOIN ${target}.record_evidence v ON v.record_event_id=e.id
      JOIN ${target}.roster_file_classification c ON c.title_code=r.title_code`))
      .toBe('7|17|29|2024|37| 附件一 |9')
    expect(query(`SELECT id, public_id, raw_response_sha256 FROM ${target}.platform_collection`))
      .toBe('41|42|' + createHash('sha256').update(Buffer.from('00ff0d0a', 'hex')).digest('hex'))
    const scope = JSON.parse(query(`SELECT json_build_object('conditions',condition_facts,'unfinished',unfinished_positions)
      FROM ${target}.platform_collection WHERE id=41`))
    expect(scope).toEqual({
      conditions: { values: { combination: { kind: 'text', value: 'and' } },
        witnesses: { rddqrq: { kind: 'text', storage: 'text', bytes: 'IDAxIA==' } } },
      unfinished: [
        { ordinal: 2, source: 'queryBusList', rdjb: '2', pageNo: null },
        { ordinal: 8, source: 'queryBusList', rdjb: '3', pageNo: 2 },
      ],
    })
    expect(query(`SELECT to_regclass('${target}.platform_collection_condition') IS NULL AND
      to_regclass('${target}.platform_collection_unfinished') IS NULL`)).toBe('t')
    expect(query(`SELECT to_regclass('${target}.platform_archive_value') IS NULL`)).toBe('t')
    expect(query(`SELECT encode(bytes,'hex') FROM ${staging}.platform_archive_value WHERE id=47`)).toBe('00ff0d0a')
    const migratedRaw = query(`SELECT json_build_object(
      'nameRaw', coalesce(name_raw_json::json, to_json(name_raw)),
      'usccRaw', coalesce(uscc_raw_json::json, to_json(uscc_raw)),
      'districtRaw', coalesce(district_raw_json::json, to_json(district_raw)))
      FROM ${target}.official_evidence_row_revision WHERE evidence_id=37 AND revision=1`)
    expect(JSON.parse(migratedRaw)).toEqual({ nameRaw: '公布名' + String.fromCharCode(0) + '🙂', usccRaw: ' 原统代 ', districtRaw: null })
    expect(query(`SELECT last_value,is_called FROM ${target}.record_evidence_id_seq`)).toBe('71|f')

    const rejected = (sql: string, error: string) => {
      const result = spawnSync(psql, [...command, '-c', sql], { env, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(error)
    }
    rejected(`UPDATE ${target}.platform_collection SET condition_facts = condition_facts - 'witnesses'
      WHERE id=41`, 'witnesses are immutable')
    rejected(`INSERT INTO ${target}.record_event(record_id,event_type) VALUES(999,'award')`, 'foreign key constraint')
    query(`INSERT INTO ${target}.enterprise_merge VALUES (7,8)`)
    expect(query(`SELECT enterprise_id FROM ${target}.roster_legacy_member ORDER BY enterprise_id`)).toBe('7\n8')
    const replay = materialize()
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toContain('already exists')
    expect(query(`SELECT count(*) FROM ${target}.record_evidence`)).toBe('1')
    expect(query(`SELECT count(*) FROM ${staging}.record_evidence`)).toBe('1')

    createCore(failedTarget)
    query(`UPDATE ${staging}.record_event SET record_id=999`)
    const orphan = materialize(failedTarget)
    expect(orphan.status).not.toBe(0)
    expect(orphan.stderr).toContain('foreign key constraint')
    expect(query(`SELECT to_regclass('${failedTarget}.title') IS NULL`)).toBe('t')
  } finally {
    try {
      query(`SET client_min_messages TO warning; DROP SCHEMA IF EXISTS ${target} CASCADE; DROP SCHEMA IF EXISTS ${failedTarget} CASCADE; DROP SCHEMA IF EXISTS ${staging} CASCADE`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
}, 45_000)

test.runIf(Boolean(connection))('retains the SQLite type and bytes of declaration and process evidence', async () => {
  const fixture = nativeCatalogFixture()
  const suffix = randomUUID().replaceAll('-', '')
  const staging = 'platform_exact_stage_' + suffix
  const target = 'platform_exact_' + suffix
  const psql = process.env.PGSQL_BIN ?? 'psql'
  const env = { ...process.env, PGDATABASE: connection }
  const args = ['-X', '-w', '-Atq', '-v', 'ON_ERROR_STOP=1']
  const query = (sql: string) => execFileSync(psql, [...args, '-c', sql], { env, encoding: 'utf8' }).trim()
  const snapshot = join(fixture.dir, 'offline.sqlite')

  try {
    const raw = fixture.raw('EXACT-1', { year: 2024, sblx: '申请', cszt: '通过' })
    const declaration = fixture.seed('apply_list', raw).observations[0]!.observationId
    const business = fixture.seed('business_list', raw).observations[0]!.observationId
    const sqlite = fixture.db.$client
    sqlite.exec('DROP TRIGGER platform_apply_stored_no_update; DROP TRIGGER platform_process_stored_no_update')
    sqlite.prepare(`UPDATE platform_apply_projection
      SET exact_title_raw = ?, exact_year = 2024.5, exact_status = ' 通过 ', exact_applied_at = NULL
      WHERE observation_id = ?`).run(Buffer.from([0, 255, 32]), declaration)
    sqlite.prepare(`UPDATE platform_business_projection
      SET exact_title_raw = ' 2 ', exact_year = 2024, exact_batch = ?, exact_province = NULL
      WHERE observation_id = ?`).run(Buffer.from([255, 0]), business)
    await sqlite.backup(snapshot)
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', snapshot, staging], { env })
    query(`CREATE SCHEMA ${target};
      CREATE TABLE ${target}.enterprise(id bigint PRIMARY KEY);
      CREATE TABLE ${target}.enterprise_merge(from_enterprise_id bigint, into_enterprise_id bigint);
      CREATE TABLE ${target}.stored_file(id bigint PRIMARY KEY);
      INSERT INTO ${target}.enterprise VALUES (${fixture.enterprise.id});`)
    execFileSync(psql, [...args, '-v', `staging=${staging}`, '-v', `target=${target}`,
      '-f', 'upgrade/postgresql/materialize-roster.sql'], { env })

    expect(query(`SELECT exact_title_raw_sqlite_storage,encode(exact_title_raw,'hex'),
      exact_year_sqlite_storage,encode(exact_year,'hex'),exact_status_sqlite_storage,convert_from(exact_status,'UTF8'),
      exact_applied_at_sqlite_storage,exact_applied_at IS NULL
      FROM ${target}.platform_apply_projection WHERE observation_id=${declaration}`))
      .toBe('blob|00ff20|real|409fa20000000000|text| 通过 |null|t')
    expect(query(`SELECT exact_title_raw_sqlite_storage,convert_from(exact_title_raw,'UTF8'),
      exact_year_sqlite_storage,encode(exact_year,'hex'),exact_batch_sqlite_storage,encode(exact_batch,'hex'),
      exact_province_sqlite_storage,exact_province IS NULL
      FROM ${target}.platform_business_projection WHERE observation_id=${business}`))
      .toBe('text| 2 |integer|00000000000007e8|blob|ff00|null|t')
  } finally {
    try {
      query(`SET client_min_messages TO warning; DROP SCHEMA IF EXISTS ${target} CASCADE; DROP SCHEMA IF EXISTS ${staging} CASCADE`)
    } finally {
      fixture.close()
    }
  }
}, 45_000)
