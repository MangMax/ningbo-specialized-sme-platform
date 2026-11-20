import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { handleRosterImportRequest } from '../../../layers/sme-roster/server/utils/roster-import-http'
import { submitRosterImportMcp } from '../../../layers/sme-roster/server/utils/roster-import-mcp-submission'
import { reserveLoopbackPort } from '../../support/owned-process.mjs'

vi.mock('@db', () => ({ useDb: () => { throw new Error('Unexpected SQLite access in PostgreSQL mode') } }))

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const queriedAt = '2026-11-11T00:00:00Z'
const queryKey = 'name:孤立历史'
const originalRaw = '{ "rdjb": "2", "id": "history-A", "year": 2024, "sblx": "申请", "cszt": "通过" }'
const originalSource = '历史原文\r\n🧾'
const historical = [
  { interface: 'apply_list', queryId: 91, relationId: 101, key: 'history-A', raw: originalRaw, result: 'apply' },
  { interface: 'business_list', queryId: 92, relationId: 102, key: 'history-B', raw: '{ "id": "history-B", "year": 2024 }', result: 'business' },
  { interface: 'recognized_list', queryId: 93, relationId: 103, key: 'history-C', raw: '{ "id": "history-C", "rdjb": "2", "whpcyear": "2024" }', result: 'recognized' },
] as const

describe.skipIf(!bin)('native PostgreSQL platform observation import', () => {
  let root: string
  let data: string
  let started = false
  let client: pg.Client
  let originals: unknown[]
  const token = 'isolated-platform-observation-test'
  const command = (name: string, args: string[]) =>
    execFileSync(join(bin!, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'platform-observation-pg-'))
    data = join(root, 'pg')
    const port = await reserveLoopbackPort()
    const url = 'postgresql://platform_fixture@127.0.0.1:' + port + '/postgres'
    command('initdb', ['-D', data, '-U', 'platform_fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -k ' + root, '-w', 'start'])
    started = true
    client = new pg.Client({ connectionString: url })
    await client.connect()
    await client.query(`
      CREATE SCHEMA business;
      SET search_path TO business;
      CREATE TABLE enterprise (id bigint PRIMARY KEY, name_norm text, uscc_norm text);
      CREATE TABLE enterprise_merge (from_enterprise_id bigint, into_enterprise_id bigint);
      CREATE TABLE stored_file (id bigint PRIMARY KEY);
      CREATE TABLE service_credential (key text, value text, updated_at text);
    `)
    command('psql', ['-X', '-w', '-d', url, '-v', 'ON_ERROR_STOP=1', '-c', 'SET search_path TO business,pg_catalog',
      ...['roster-schema', 'roster-platform-schema', 'roster-review-schema', 'roster-constraints', 'roster-triggers']
        .flatMap(file => ['-f', 'db/postgresql/' + file + '.sql'])])
    await client.query("INSERT INTO platform_legacy_alias_sequence VALUES ('query', 93), ('relation', 103)")
    for (const original of historical) await seedLegacyObservation(original)
    vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: root }))
    vi.stubEnv('NUXT_DB_READONLY', '1')
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '1')
    vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
    vi.stubEnv('NUXT_POSTGRES_JOBS', undefined)
    originals = await readOriginals()
  }, 60_000)

  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
      await client?.end()
    } finally {
      try {
        if (started) command('pg_ctl', ['-D', data, '-w', '-m', 'fast', 'stop'])
      } finally {
        if (root) rmSync(root, { recursive: true, force: true })
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
      }
    }
  })

  async function seedLegacyObservation(original: {
    queryId: number; relationId: number; key: string; raw: string
    result: typeof historical[number]['result']; interface: typeof historical[number]['interface']
    time?: string; status?: Buffer
  }) {
    const { queryId, relationId, key, raw, result, interface: source, time = queriedAt, status = null } = original
    const id = relationId - 90
    await client.query('BEGIN')
    await client.query(`
      INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version)
      VALUES ($1,$2,$3,'2',$4,$4,'success','unknown','unknown','absent','fixture')
    `, [id, source, queryKey, time])
    await client.query('INSERT INTO platform_legacy_query_alias(old_id,collection_id) VALUES ($1,$2)', [queryId, id])
    await client.query(`
      INSERT INTO platform_business_observation(id,collection_id,sequence_no,source_relation_key,identity_state,content_state,position_state,
        apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state,process_exact_owner_id,process_exact_state,process_sql_fact_title_state)
      VALUES ($1,$1,1,$2,'not_indexed','not_indexed','unknown',
        CASE WHEN $3='apply' THEN $1::bigint END,CASE WHEN $3='apply' THEN 'captured' END,CASE WHEN $3='apply' THEN 'captured' END,
        CASE WHEN $3='business' THEN $1::bigint END,CASE WHEN $3='business' THEN 'captured' END,CASE WHEN $3='business' THEN 'captured' END)
    `, [id, key, result])
    await client.query('INSERT INTO platform_legacy_relation_alias(old_id,observation_id) VALUES ($1,$2)', [relationId, id])
    await client.query(`
      INSERT INTO platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin)
      VALUES ($1,1,'none','pending','migrated_current')
    `, [id])
    const values = {
      id: relationId, query_id: queryId, sequence_no: 1, relation_key: key, enterprise_id: null, raw_fields: raw,
      source_text: originalSource, title_raw: null, uscc_raw: null, name_raw: null, alias_name_raw: null, province: null,
      status, batch: null, declare_kind: null, applied_at: null, award_batch_label: null, year: null,
      match_basis: 'none', verification_status: 'pending', created_at: time,
    }
    const fields = Object.entries(values).map(([name, value]) => ({
      name, storageClass: value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value === 'number' ? 'integer' : 'text',
      hex: value === null ? '' : (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString('hex'),
    }))
    const snapshot = Buffer.from(JSON.stringify({ encoding: 't05a-sqlite-cells-v1', fields }))
    const archiveFields = [
      ['platform_collection_archive_ref', 'rawResponse', 'text', Buffer.from('original response')],
      ['platform_collection_archive_ref', 'collectionEvidence', 'null', null],
      ['platform_observation_archive_ref', 'rawFields', 'text', Buffer.from(raw)],
      ['platform_observation_archive_ref', 'sourceText', 'text', Buffer.from(originalSource)],
      ['platform_observation_archive_ref', 'legacyRowSnapshot', 'blob', snapshot],
    ] as const
    let rawArchiveId: string | undefined
    for (const [table, field, storage, bytes] of archiveFields) {
      const { rows: [archive] } = await client.query(`
        INSERT INTO platform_archive_value(storage_class,bytes,byte_length,sha256)
        VALUES($1,$2,octet_length($2::bytea),encode(sha256($2::bytea),'hex')) RETURNING id
      `, [storage, bytes])
      await client.query(`INSERT INTO ${table}(owner_id,field,archive_id) VALUES($1,$2,$3)`, [id, field, archive.id])
      if (field === 'rawFields') rawArchiveId = archive.id
    }
    await client.query('UPDATE platform_collection_archive_ref SET sealed=1 WHERE owner_id=$1', [id])
    await client.query('UPDATE platform_observation_archive_ref SET sealed=1 WHERE owner_id=$1', [id])
    const kindColumns = ['province', 'status', 'batch', 'declare_kind', 'applied_at', 'award_batch_label', 'year']
      .flatMap(field => ['stored_' + field + '_kind', 'parsed_' + field + '_kind', field + '_conflict'])
    const kindValues = kindColumns.map(col => col === 'stored_status_kind' && status ? "'blob'" : col.endsWith('_kind') ? "'absent'" : '0')
    const yearColumn = { apply: 'declaration_year', business: 'business_year', recognized: 'maintenance_year' }[result]
    const storedPrefix = result === 'business' ? 'process' : result
    const exact = result === 'recognized' ? '' :
      `, exact_stored_state, exact_stored_rule, exact_stored_origin, sql_fact_title_state, sql_fact_title_rule`
    const exactValues = result === 'recognized' ? '' :
      `, 'captured', '${storedPrefix}-stored-cells-v1', 'legacy_source', 'captured', '${storedPrefix}-legacy-sql-fact-title-v1'`
    const blobColumns = status ? ', exact_status, exact_status_sqlite_storage, stored_status, stored_status_sqlite_storage, reconciled_status, reconciled_status_sqlite_storage' : ''
    const blobValues = status ? ", $5, 'blob', $5, 'blob', $5, 'blob'" : ''
    await client.query(`
      INSERT INTO platform_${result}_projection(observation_id,basis,source_title_kind,source_title_rule_version,
        source_archive_id,parse_state,rule_version,created_at,${yearColumn},${kindColumns.join(',')}${exact}${blobColumns})
      VALUES ($1,'observation_reconciliation','absent','fixture',$2,'valid',$3,$4,2024,${kindValues.join(',')}${exactValues}${blobValues})
    `, [id, rawArchiveId, 'platform-' + result + '-v1', time, ...(status ? [status] : [])])
    await client.query('COMMIT')
  }

  async function readOriginals() {
    return (await client.query(`
      SELECT q.old_id AS query_id,a.old_id AS relation_id,o.id, r.field,v.storage_class,v.id AS archive_id,v.bytes,
        p.revision,p.enterprise_id,p.match_basis,p.origin
      FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
      JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id
      JOIN platform_observation_archive_ref r ON r.owner_id=o.id JOIN platform_archive_value v ON v.id=r.archive_id
      JOIN platform_observation_assignment p ON p.observation_id=o.id
      WHERE a.old_id BETWEEN 101 AND 103 ORDER BY a.old_id,r.field,p.revision
    `)).rows
  }

  function request(idempotencyKey: string, payload: RosterImportRequest['payload']): RosterImportRequest {
    return { idempotencyKey, sourceKind: 'platform_archive', sourceIdentity: 'isolated-history', payload }
  }

  const http = (action: 'commit' | 'preflight' | 'replay', body: RosterImportRequest) =>
    handleRosterImportRequest(action, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body },
      { apiToken: token, db: undefined as never })

  const mcp = (action: 'commit' | 'preflight', body: RosterImportRequest) =>
    submitRosterImportMcp(action, { ...body, sourceSha256: body.sourceSha256 ?? undefined })

  it('freezes original aliases through HTTP and indexes only version projections through MCP', async () => {
    const ids = historical.map(row => ({ relationId: row.relationId }))
    const reference = request('unindexed-reference', { platformQueries: [{
      interface: 'apply_list', queryKey, rdjb: '2', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
    }] })
    expect(await http('commit', reference)).toMatchObject({ status: 200, body: { status: 'committed', items: [{
      ref: 'query:91', detail: { rowsWritten: 0, canonicalProjection: [] },
    }] } })
    expect((await client.query('SELECT count(*)::int AS n FROM platform_observation_fingerprint_basis')).rows).toEqual([{ n: 0 }])
    const { rows: [conflictingRecord] } = await client.query(`
      INSERT INTO platform_business_record(interface,platform_key,identity_rule_version,created_at)
      VALUES ('business_list','history-B','prior-rule',$1) RETURNING id
    `, [queriedAt])
    try {
      const failure = {
        status: 'failed', summary: { written: 0, skipped: 0, failed: 3, evidenceRepointed: 0 }, items: [
          { kind: 'platform_observation', ref: 'relation:101', ok: false, error: { code: 'commit_rolled_back' } },
          { kind: 'platform_observation', ref: 'relation:102', ok: false, error: { code: 'projection_rule_conflict' } },
          { kind: 'platform_observation', ref: 'relation:103', ok: false, error: { code: 'not_executed' } },
        ],
      }
      expect(await mcp('commit', request('archive-with-incompatible-rule', { platformRecordObservations: ids }))).toMatchObject(failure)
      expect((await client.query(`
        SELECT r.status,r.summary::json AS summary,r.item_results::json AS items
        FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id
        WHERE b.idempotency_key='archive-with-incompatible-rule'
      `)).rows).toMatchObject([failure])
      expect((await client.query('SELECT count(*)::int AS n FROM platform_observation_fingerprint_basis')).rows).toEqual([{ n: 0 }])
      expect((await client.query('SELECT count(*)::int AS n FROM platform_business_record_version')).rows).toEqual([{ n: 0 }])
      expect(await readOriginals()).toEqual(originals)
    } finally {
      await client.query('DELETE FROM platform_business_record WHERE id=$1', [conflictingRecord.id])
    }

    const body = request('original-observation', { platformRecordObservations: ids })
    const expectedBytes = Buffer.from('{"interface":"apply_list","invalidRaw":null,"queriedAt":"2026-11-11T00:00:00Z","queryId":91,"queryKey":"name:孤立历史","rawFields":{"cszt":"通过","id":"history-A","rdjb":"2","sblx":"申请","year":2024},"rdjb":"2","relationKey":"history-A","sequenceNo":1}')
    const fingerprint = createHash('sha256').update(expectedBytes).digest('hex')
    const preflight = await http('preflight', body)
    expect(preflight).toMatchObject({ status: 200, body: { status: 'preflight', preflight: {
      add: 0, update: 0, review: 0, conflicts: [],
      platformObservationSources: [{ relationId: 101, inputFingerprint: fingerprint }, { relationId: 102 }, { relationId: 103 }],
      canonicalProjection: [
        { relationId: 101, applyProjection: { declarationYear: 2024, status: '通过' } },
        { relationId: 102, businessProjection: { businessYear: 2024 } },
        { relationId: 103, recognizedProjection: { maintenanceYear: 2024 } },
      ],
    } } })
    expect((await client.query('SELECT identity_state,batch_id FROM platform_business_observation ORDER BY id')).rows)
      .toEqual(ids.map(() => ({ identity_state: 'not_indexed', batch_id: null })))

    const committed = await mcp('commit', body)
    expect(committed).toMatchObject({ status: 'committed', summary: {
      written: 0, skipped: 0, canonicalProjection: {
        recordsCreated: 3, versionsCreated: 3, observationsCreated: 3,
        applyProjectionsCreated: 1, businessProjectionsCreated: 1, recognizedProjectionsCreated: 1,
      },
      platformFields: { status: 'ready', eligibleVersions: 3, projectionsCreated: 3, observationsChecked: 3 },
    } })
    expect(await http('commit', body)).toMatchObject({ status: 200, body: committed })
    const ledger = await client.query(`
      SELECT a.old_id AS relation_id,o.batch_id,o.indexed_at,o.input_fingerprint,b.scheme,v.bytes
      FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
      JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id JOIN platform_archive_value v ON v.id=b.input_archive_id
      ORDER BY a.old_id
    `)
    expect(ledger.rows[0]).toMatchObject({ relation_id: '101', batch_id: expect.any(String), scheme: 'legacy-bootstrap-v1',
      indexed_at: expect.any(String), input_fingerprint: fingerprint, bytes: expectedBytes })
    expect(await readOriginals()).toEqual(originals)

    for (const original of historical) {
      const prefix = original.result === 'apply' ? 'apply' : original.result
      const owners = (await client.query(`SELECT observation_id,version_id FROM platform_${prefix}_projection ORDER BY id`)).rows
      expect(owners).toEqual([
        { observation_id: expect.any(String), version_id: null }, { observation_id: null, version_id: expect.any(String) },
      ])
    }
    expect((await client.query(`
      SELECT r.operation,r.status FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id
      WHERE b.idempotency_key='original-observation' ORDER BY r.id
    `)).rows).toEqual([
      { operation: 'preflight', status: 'preflight' }, { operation: 'commit', status: 'committed' },
    ])

    const reuse = await http('commit', request('same-original-different-key', { platformRecordObservations: ids }))
    expect(reuse).toMatchObject({ status: 200, body: { status: 'committed', summary: { written: 0, canonicalProjection: {
      recordsCreated: 0, versionsCreated: 0, observationsCreated: 0, observationsReused: 3,
    } } } })
    expect((await client.query('SELECT batch_id,indexed_at,input_fingerprint FROM platform_business_observation ORDER BY id')).rows)
      .toEqual(ledger.rows.map(({ batch_id, indexed_at, input_fingerprint }) => ({ batch_id, indexed_at, input_fingerprint })))
  })

  it('returns only requested archived query projections and keeps reference-only imports read-only', async () => {
    const body = request('query-reference', { platformQueries: [{
      interface: 'apply_list', queryKey, rdjb: '2', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
    }] })
    expect(await mcp('preflight', body)).toMatchObject({ status: 'preflight', preflight: {
      add: 0, conflicts: [], canonicalProjection: [{ relationId: 101, applyProjection: { declarationYear: 2024 } }],
    } })
    expect(await http('commit', body)).toMatchObject({ status: 200, body: { status: 'committed', items: [{
      ref: 'query:91', detail: { relations: [], skipped: 1, rowsWritten: 0, canonicalProjection: [{
        relationId: 101, recordId: expect.any(Number), versionId: expect.any(Number),
        recordCreated: false, versionCreated: false, observationCreated: false,
      }] },
    }], summary: { written: 0, skipped: 1, platformFields: { status: 'partial', observationsChecked: 0 } } } })
    expect(await readOriginals()).toEqual(originals)
  })

  it('resolves a command-written collection by original alias and reuses the sealed command fingerprint', async () => {
    await client.query("UPDATE platform_legacy_alias_sequence SET high_water=8000 WHERE namespace IN ('query','relation')")
    const time = '2026-11-12T00:00:00Z'
    const query = { interface: 'apply_list', queryKey, rdjb: '2', queriedAt: time } as const
    const original = request('native-source', { platformQueries: [{
      ...query, rawResponse: 'native archive', status: 'success',
      relations: [{ sequenceNo: 1, relationKey: 'new-key', nameRaw: '企业甲', usccRaw: '91330200123456789X',
        sourceText: '  未改动原文🧾  ', rawFields: { year: 2025, id: 'new-key' } }],
    }] })
    const committed = await http('commit', original)
    expect(committed).toMatchObject({ status: 200, body: { status: 'committed', items: [{
      ref: 'query:8001', detail: { canonicalProjection: [{ relationId: 8001, inputFingerprint: expect.any(String) }] },
    }] } })
    const { rows: [owner] } = await client.query(`
      SELECT o.id::float8 AS physical, o.input_fingerprint, o.batch_id, o.indexed_at
      FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id WHERE a.old_id=8001
    `)
    expect(owner.physical).not.toBe(8001)
    expect(await mcp('preflight', request('physical-id', { platformRecordObservations: [{ relationId: owner.physical }] })))
      .toMatchObject({ status: 'preflight', preflight: { conflicts: [{ error: { code: 'projection_source_missing' } }] } })
    expect(await http('commit', request('native-source-reference', { platformQueries: [{
      ...query, reuseExisting: true, relations: [{ sequenceNo: 1 }],
    }] }))).toMatchObject({ status: 200, body: { status: 'committed', items: [{
      ref: 'query:8001', detail: { canonicalProjection: [{ relationId: 8001, inputFingerprint: owner.input_fingerprint, observationCreated: false }] },
    }] } })
    expect(await mcp('commit', request('native-observation-reference', { platformRecordObservations: [{ relationId: 8001 }] })))
      .toMatchObject({ status: 'committed', summary: { canonicalProjection: { observationsReused: 1, applyProjectionsReused: 1 } } })
    expect((await client.query('SELECT id::float8 AS physical,input_fingerprint,batch_id,indexed_at FROM platform_business_observation WHERE id=$1', [owner.physical])).rows)
      .toEqual([owner])
  })

  it('rejects a missing alias atomically and keeps the original request bound to its preflight key', async () => {
    const body = request('historical-conflict', { platformRecordObservations: [{ relationId: 101 }, { relationId: 901 }] })
    expect(await mcp('preflight', body)).toMatchObject({ status: 'preflight', preflight: { conflicts: [
      { ref: 'relation:901', error: { code: 'projection_source_missing' } },
    ] } })
    const changed = request(body.idempotencyKey, { platformRecordObservations: [{ relationId: 101 }] })
    expect(await http('commit', changed)).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
    expect(await http('commit', body)).toMatchObject({ status: 200, body: { status: 'failed', summary: { written: 0, failed: 1 } } })
    expect(await http('replay', body)).toMatchObject({ status: 400 })
    expect(await readOriginals()).toEqual(originals)
  })

  it('verifies an unindexed business status BLOB by reference and rejects ordinary first indexing', async () => {
    const time = '2026-11-13T00:00:00Z'
    const rawFields = { id: 'blob-status', year: 2024 }
    const status = Buffer.from([0x00, 0xff])
    await seedLegacyObservation({ interface: 'business_list', result: 'business', queryId: 94, relationId: 104,
      key: rawFields.id, raw: JSON.stringify(rawFields), time, status })
    const query = { interface: 'business_list', queryKey, rdjb: '2', queriedAt: time } as const
    const reference = request('blob-status-reference', { platformQueries: [{
      ...query, reuseExisting: true, relations: [{ sequenceNo: 1 }],
    }] })
    expect(await http('preflight', reference)).toMatchObject({ status: 200, body: { status: 'preflight', preflight: {
      conflicts: [], canonicalProjection: [{ relationId: 104, businessProjection: { businessYear: 2024 } }],
    } } })
    expect(await http('commit', reference)).toMatchObject({ status: 200, body: { status: 'committed', items: [{
      ref: 'query:94', detail: { rowsWritten: 0, canonicalProjection: [] },
    }] } })

    const historicalIndex = request('blob-status-index', { platformRecordObservations: [{ relationId: 104 }] })
    expect(await mcp('preflight', historicalIndex)).toMatchObject({ status: 'preflight', preflight: {
      conflicts: [], platformObservationSources: [{ relationId: 104, inputFingerprint: expect.any(String) }],
    } })
    const drift = { code: 'projection_source_drift', message: 'Legacy text class conflict' }
    expect(await mcp('commit', historicalIndex)).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 }, items: [{
      ok: false, kind: 'platform_observation', ref: 'relation:104', error: drift,
    }] })

    const ordinaryReplay = request('blob-status-replay', {
      platformQueries: [
        { interface: 'apply_list', queryKey, rdjb: '2', queriedAt, reuseExisting: true },
        { ...query, rawResponse: 'original response', relations: [{ sequenceNo: 1, rawFields }] },
      ],
      platformRecordObservations: [{ relationId: 103 }],
    })
    expect(await http('commit', ordinaryReplay)).toMatchObject({ status: 200, body: {
      status: 'failed', summary: { written: 0, failed: 3 }, items: [
        { ok: false, kind: 'platform_query', ref: 'query:91', error: { code: 'commit_rolled_back' } },
        { ok: false, kind: 'platform_relation', ref: 'relation:104', error: { ...drift, field: 'relations' } },
        { ok: false, kind: 'platform_observation', ref: 'relation:103', error: { code: 'not_executed' } },
      ],
    } })
    expect((await client.query(`
      SELECT o.identity_state,o.content_state,o.record_id,o.version_id,o.input_fingerprint,o.batch_id,b.scheme,
        p.exact_status,p.exact_status_sqlite_storage
      FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
      JOIN platform_business_projection p ON p.observation_id=o.id
      LEFT JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id
      WHERE a.old_id=104
    `)).rows).toEqual([{ identity_state: 'not_indexed', content_state: 'not_indexed', record_id: null, version_id: null,
      input_fingerprint: null, batch_id: null, scheme: null, exact_status: status, exact_status_sqlite_storage: 'blob' }])
    expect((await client.query("SELECT id FROM platform_business_record WHERE platform_key='blob-status'")).rows).toEqual([])
  })
})
