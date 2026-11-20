import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { nativeAppAdapter } from '../../support/native-app'
import { reserveLoopbackPort } from '../../support/owned-process.mjs'

const bin = process.env.LEAD_TEST_POSTGRES_BIN
const versions = '/api/lead-lists/versions'
const agent = { actor: { type: 'agent', id: 'lead-review' }, basis: '逐行核对原件' }

describe.skipIf(!bin)('native PostgreSQL lead supplementation', () => {
  let dir: string
  let data: string
  const command = (name: string, args: string[], options = {}) =>
    execFileSync(join(bin!, name), args, { stdio: 'pipe', ...options })
  let port: number
  let started = false
  let db: pg.Pool
  let app: ReturnType<typeof nativeAppAdapter>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lead-pg-'))
    data = join(dir, 'pg')
    app = nativeAppAdapter({
      dir, token: 'isolated-lead-pg-token',
      launch: ({ cwd, port: httpPort }) => ({
        args: [join(cwd, '.output/server/index.mjs')],
        env: {
          NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(httpPort),
          NUXT_DB_READONLY: '1', NUXT_POSTGRES_DIRECTORY_WRITE: '1', NUXT_POSTGRES_LEAD_REGISTRATION: '1',
          NUXT_POSTGRES_DIRECTORY_URL: `postgresql://lead_fixture@127.0.0.1:${port}/postgres`,
        },
      }),
    })
    installLeadListSchema(app.db.$client)
    app.db.$client.exec(`
      INSERT INTO stored_file (id,rel_path,filename,ext,sha256,bytes,created_at)
        VALUES (91,'fixture.csv','fixture.csv','csv','fixture-hash',12,'2026-11-18');
      INSERT INTO lead_list_version (id,series,channel_code,list_type_code,acquired_on,file_id,file_sha256,request_hash,created_at)
        VALUES (11,'走访名单','research','lead','2026-11-18',91,'fixture-hash','request-one','2026-11-18'),
               (12,'另一个名单','research','lead','2026-11-18',91,'fixture-hash','request-two','2026-11-18');
      INSERT INTO lead_list_row (id,version_id,row_number,name,uscc)
        VALUES (101,11,2,'原始企业','待核对'), (102,11,3,'另一行',NULL),
               (201,12,2,'其他名单行',NULL), (202,12,3,'同一名单另一行',NULL);
      INSERT INTO enterprise_source (id,module,business_table,version_key,channel_code,list_type_code,acquired_on,series,file_id,sha256)
        VALUES (71,'lead-lists','lead_list_version','11','research','lead','2026-11-18','走访名单',91,'fixture-hash');
      PRAGMA wal_checkpoint(TRUNCATE);
    `)
    port = await reserveLoopbackPort()
    command('initdb', ['-D', data, '-U', 'lead_fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    command('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'])
    started = true
    const env = {
      ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'lead_fixture', PGDATABASE: 'postgres',
      PGSQL_BIN: join(bin!, 'psql'),
    }
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', app.dbPath, 'lead_staging'], { env })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists']) {
      command('psql', ['-X', '-w', '-v', 'staging=lead_staging', '-f', `upgrade/postgresql/materialize-${name}.sql`], { env })
    }
    db = new pg.Pool({ host: '127.0.0.1', port, user: 'lead_fixture', database: 'postgres', options: '-c search_path=business,public' })
    await app.start()
  }, 60_000)

  afterAll(async () => {
    try {
      await app?.close()
    } finally {
      await db?.end()
      if (started) command('pg_ctl', ['-D', data, '-w', '-m', 'fast', 'stop'])
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const submit = (id: number, body: object, headers: HeadersInit = app.headers) =>
    app.request(`${versions}/${id}/supplement`, { method: 'POST', headers, body: JSON.stringify(body) })

  it('rolls back foreign rows and returns one provenance receipt across concurrent repeats', async () => {
    const create = { action: 'create', rowId: 101, fields: { name: '已核对企业' } }
    const wrongVersion = await submit(11, { ...agent, decisions: [create, { ...create, rowId: 201 }] })
    expect(wrongVersion.status, await wrongVersion.text()).toBe(404)
    expect(await (await app.request('/api/core/enterprises')).json()).toMatchObject({ rows: [] })
    const rollback = await submit(11, {
      ...agent, decisions: [create, { action: 'attach', rowId: 102, enterpriseId: 999, expectedRevision: 1 }],
    })
    expect(rollback.status, await rollback.text()).toBe(404)
    expect(await (await app.request('/api/core/enterprises')).json()).toMatchObject({ rows: [] })

    const body = { ...agent, decisions: [create] }
    const responses = await Promise.all([submit(11, body), submit(11, body)])
    const receipts = await Promise.all(responses.map(response => response.json()))
    expect(responses.map(response => response.status), JSON.stringify(receipts)).toEqual([200, 200])
    const id = receipts[0].rows[0].enterpriseId
    expect(receipts).toEqual(Array(2).fill({ sourceId: 71, rows: [{ rowId: 101, enterpriseId: id }] }))
    expect(typeof id).toBe('number')
    const changed = await submit(11, { ...body, basis: '另一次核对' })
    expect(changed.status).toBe(409)

    const details = await (await app.request(`${versions}/11`)).json()
    expect(details.rows).toMatchObject([
      { id: 101, name: '原始企业', uscc: '待核对', enterpriseId: id }, { id: 102, enterpriseId: null },
    ])
    const sources = await (await app.request(`/api/core/enterprises/${id}/sources`)).json()
    expect(sources).toMatchObject([{ id: 71, fileId: 91, sha256: 'fixture-hash', versionKey: '11' }])
    expect((await db.query('SELECT review_actor,review_basis FROM lead_list_row WHERE id=101')).rows).toEqual([
      { review_actor: JSON.stringify(agent.actor), review_basis: agent.basis },
    ])
    expect((await (await app.request('/api/roster/enterprises')).json()).rows).toEqual([])
  })

  it('checks browser access and revision, then retains the alias, profile audit and roster identity work', async () => {
    const created = await app.request('/api/core/enterprises', {
      method: 'POST', body: JSON.stringify({ name: '原资料现名' }),
    })
    expect(created.status).toBe(200)
    const target = await created.json()
    const detailsPath = `/api/core/enterprises/${target.id}/details`
    const uscc = '913302017133602847'
    const decision = {
      action: 'attach', rowId: 201, enterpriseId: target.id, expectedRevision: 1,
      fields: { name: '核对后现名', uscc },
    }
    const browserHeaders = {
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
      'x-lead-list-browser': '1', origin: new URL(app.url('/')).origin,
    }
    const body = { decisions: [decision] }
    expect((await submit(12, body, { ...browserHeaders, 'sec-fetch-site': 'cross-site' })).status).toBe(401)
    const stale = await submit(12, { decisions: [{ ...decision, expectedRevision: 2 }] }, browserHeaders)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ data: { code: 'enterprise_changed' } })

    // The baseline has no native roster tables. An identity change must roll back while they are unavailable.
    const unavailable = await submit(12, body, browserHeaders)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ data: { code: 'roster_identity_evidence_unavailable' } })
    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '原资料现名', uscc: null, revision: 1 })
    expect((await (await app.request(`${versions}/12`)).json()).rows[0].enterpriseId).toBeNull()
    expect((await db.query('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=$1', [target.id])).rows).toEqual([])
    const sourcesPath = `/api/core/enterprises/${target.id}/sources`
    expect(await (await app.request(sourcesPath)).json()).toMatchObject([{ module: 'core' }])

    // Model the missing roster materializer's current row names and required write constraints.
    await db.query(`
      CREATE TABLE record AS TABLE lead_staging.record WITH NO DATA;
      CREATE TABLE record_event AS TABLE lead_staging.record_event WITH NO DATA;
      CREATE TABLE difference_reason AS TABLE lead_staging.difference_reason WITH NO DATA;
      CREATE TABLE evidence_revision_113 AS TABLE lead_staging.evidence_revision_113 WITH NO DATA;
      ALTER TABLE evidence_revision_113 ALTER COLUMN id SET NOT NULL, ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      ALTER TABLE evidence_revision_113 ADD UNIQUE (source_kind, source_key, source_version);
      CREATE TABLE evidence_semantic_head_113 AS TABLE lead_staging.evidence_semantic_head_113 WITH NO DATA;
      ALTER TABLE evidence_semantic_head_113 ADD PRIMARY KEY (source_key);
      CREATE TABLE evidence_impact_progress_113 AS TABLE lead_staging.evidence_impact_progress_113 WITH NO DATA;
      ALTER TABLE evidence_impact_progress_113 ALTER COLUMN cursor SET DEFAULT 0, ALTER COLUMN done SET DEFAULT 0;
      CREATE TABLE evidence_scope_version_113 AS TABLE lead_staging.evidence_scope_version_113 WITH NO DATA;
      ALTER TABLE evidence_scope_version_113 ADD PRIMARY KEY (scope_key);
      CREATE TABLE evidence_revision_event_113 AS TABLE lead_staging.evidence_revision_event_113 WITH NO DATA;
      ALTER TABLE evidence_revision_event_113 ADD UNIQUE (revision_id, event_id);
      INSERT INTO difference_reason(id) VALUES (401);
    `)
    await db.query("INSERT INTO record(id,enterprise_id,title_code) VALUES (301,$1,'specialized_sme')", [target.id])
    await db.query('INSERT INTO record_event(id,record_id) VALUES (302,301)')

    const response = await submit(12, body, browserHeaders)
    const receipt = await response.json()
    expect(response.status, JSON.stringify(receipt)).toBe(200)
    expect(receipt.rows).toEqual([{ rowId: 201, enterpriseId: target.id }])
    const replay = await submit(12, body, browserHeaders)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '核对后现名', uscc, revision: 2 })
    const audit = (await db.query(`
      SELECT p.id, p.idempotency_key, p.before, p.after, p.actor, p.basis, a.name, a.verification_status, f.uscc
      FROM enterprise_profile_audit p JOIN enterprise_alias a ON a.id=p.retained_alias_id
      JOIN enterprise_former_name f ON f.alias_id=a.id WHERE p.enterprise_id=$1
    `, [target.id])).rows
    expect(audit).toEqual([expect.objectContaining({
      idempotency_key: 'lead-lists:201', name: '原资料现名', verification_status: 'confirmed', uscc,
      actor: '{"type":"user","id":"lead-lists-page"}', basis: '线索名单页面补充',
      before: JSON.stringify({ enterpriseId: target.id, name: '原资料现名', city: null, district: null, uscc: null }),
      after: JSON.stringify({ enterpriseId: target.id, name: '核对后现名', city: null, district: null, uscc }),
    })])
    const evidence = (await db.query(`
      SELECT r.source_key, r.source_version, r.fact_changed, r.max_decision_id, r.fact_digest,
        h.latest_revision_id = r.id AND h.fact_digest = r.fact_digest AS head,
        t.scope_key, t.pending_count, p.done, e.event_id, e.title_code
      FROM evidence_revision_113 r JOIN evidence_semantic_head_113 h ON h.source_key=r.source_key
      JOIN evidence_scope_version_113 t ON t.latest_revision_id=r.id
      JOIN evidence_impact_progress_113 p ON p.revision_id=r.id
      JOIN evidence_revision_event_113 e ON e.revision_id=r.id
    `)).rows
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const aliasDigest = hash('{"from":null,"name":"原资料现名","to":null}')
    const identityDigest = hash(`{"aliases":["${aliasDigest}"],"enterprise":{"name":"核对后现名","uscc":"913302017133602847"}}`)
    expect(evidence).toEqual([{
      source_key: `identity:enterprise:${target.id}`, source_version: `profile:${audit[0].id}`, fact_changed: '1',
      max_decision_id: '401', fact_digest: hash(JSON.stringify(identityDigest)), head: true,
      scope_key: `[${target.id},null,null]`, pending_count: '1', done: '0', event_id: '302', title_code: 'specialized_sme',
    }])
    expect((await db.query('SELECT id FROM record_event ORDER BY id')).rows).toEqual([{ id: '302' }])
    expect(await (await app.request(sourcesPath)).json()).toMatchObject([
      { module: 'core' }, { id: receipt.sourceId, module: 'lead-lists', versionKey: '12', fileId: 91 },
    ])

    const attach = { action: 'attach', rowId: 202, enterpriseId: target.id, expectedRevision: 2 }
    const unchanged = await submit(12, { ...agent, decisions: [{ ...attach, fields: { name: '核对后现名' } }] })
    expect(unchanged.status).toBe(200)
    expect(await unchanged.json()).toEqual({ sourceId: receipt.sourceId, rows: [{ rowId: 202, enterpriseId: target.id }] })
    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '核对后现名', uscc, revision: 3 })
    expect((await db.query('SELECT id FROM evidence_revision_113')).rowCount).toBe(1)
    expect((await db.query('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=$1', [target.id])).rowCount).toBe(1)
  })

  it('commits concurrent versions that attach the same companies in opposite order', async () => {
    const create = async (name: string) => {
      const response = await app.request('/api/core/enterprises', {
        method: 'POST', body: JSON.stringify({ name }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).id
    }
    const a = await create('并发核对企业甲')
    const b = await create('并发核对企业乙')
    await db.query(`
      INSERT INTO lead_list_version (id,series,channel_code,list_type_code,acquired_on,file_id,file_sha256,request_hash,created_at)
        VALUES (31,'并发名单甲','research','lead','2026-11-18',91,'fixture-hash','concurrent-first','2026-11-18'),
               (32,'并发名单乙','research','lead','2026-11-18',91,'fixture-hash','concurrent-second','2026-11-18');
      INSERT INTO lead_list_row (id,version_id,row_number,name)
        VALUES (311,31,2,'甲'),(312,31,3,'乙'),(321,32,2,'乙'),(322,32,3,'甲');
      CREATE FUNCTION hold_concurrent_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(730016);
        RETURN NEW;
      END $$;
      CREATE TRIGGER hold_concurrent_review AFTER UPDATE ON lead_list_row
        FOR EACH ROW WHEN (NEW.id IN (311,321)) EXECUTE FUNCTION hold_concurrent_review();
    `)
    const gate = await db.connect()
    await gate.query('SELECT pg_advisory_lock(730016)')
    const attach = (rowId: number, enterpriseId: number) => ({ action: 'attach', rowId, enterpriseId, expectedRevision: 1 })
    const requests = Promise.allSettled([
      submit(31, { ...agent, decisions: [attach(311, a), attach(312, b)] }),
      submit(32, { ...agent, decisions: [attach(321, b), attach(322, a)] }),
    ])
    try {
      await expect.poll(async () => {
        const result = await db.query("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()")
        return result.rows[0].waiting
      }, { timeout: 5_000 }).toBe(2)
    } finally {
      await gate.query('SELECT pg_advisory_unlock(730016)')
      gate.release()
    }
    const settled = await requests
    for (const response of settled) if (response.status === 'rejected') throw response.reason
    const responses = settled.flatMap(response => response.status === 'fulfilled' ? [response.value] : [])
    const receipts = await Promise.all(responses.map(response => response.json()))
    expect(responses.map(response => response.status), JSON.stringify(receipts)).toEqual([200, 200])
    expect(receipts.map(receipt => receipt.rows)).toEqual([
      [{ rowId: 311, enterpriseId: a }, { rowId: 312, enterpriseId: b }],
      [{ rowId: 321, enterpriseId: b }, { rowId: 322, enterpriseId: a }],
    ])
  }, 10_000)
})
