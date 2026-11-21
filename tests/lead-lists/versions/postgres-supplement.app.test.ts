import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogService } from '../../../layers/core/lib/logging/service'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { nativeAppAdapter } from '../../support/native-app'
import { reserveLoopbackPort } from '../../support/owned-process.mjs'

const bin = process.env.LEAD_TEST_POSTGRES_BIN
const versions = '/api/lead-lists/versions'
const agent = { actor: { type: 'agent', id: 'lead-review' }, basis: '逐行核对原件' }
const sourceBytes = Buffer.from('name\n原始企业\n')
const sourceSha = createHash('sha256').update(sourceBytes).digest('hex')

describe.skipIf(!bin)('PostgreSQL-only lead versions', () => {
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
    mkdirSync(join(dir, 'files'))
    writeFileSync(join(dir, 'files', 'fixture.csv'), sourceBytes)
    app = nativeAppAdapter({
      dir, token: 'isolated-lead-pg-token',
      launch: ({ cwd, port: httpPort }) => ({
        args: [join(cwd, '.output/server/index.mjs')],
        env: {
          NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(httpPort),
          NUXT_DB_MODE: 'postgresql', NUXT_DB_READONLY: '0',
          NUXT_DB_PATH: join(dir, 'legacy-runtime', 'business.db'),
          NUXT_LOG_DIR: join(dir, 'legacy-logs'),
          NUXT_POSTGRES_DIRECTORY_URL: `postgresql://lead_fixture@127.0.0.1:${port}/postgres`,
          NUXT_POSTGRES_LOG_URL: `postgresql://lead_fixture@127.0.0.1:${port}/postgres`,
        },
      }),
    })
    installLeadListSchema(app.db.$client)
    app.db.$client.exec(`
      INSERT INTO stored_file (id,rel_path,filename,ext,sha256,bytes,created_at)
        VALUES (91,'fixture.csv','fixture.csv','csv','${sourceSha}',${sourceBytes.length},'2026-11-18');
      INSERT INTO lead_list_version (id,series,channel_code,list_type_code,acquired_on,file_id,file_sha256,request_hash,created_at)
        VALUES (11,'走访名单','research','lead','2026-11-18',91,'${sourceSha}','request-one','2026-11-18'),
               (12,'另一个名单','research','lead','2026-11-18',91,'${sourceSha}','request-two','2026-11-18');
      INSERT INTO lead_list_row (id,version_id,row_number,name,uscc)
        VALUES (101,11,2,'原始企业','待核对'), (102,11,3,'另一行',NULL),
               (201,12,2,'其他名单行',NULL), (202,12,3,'同一名单另一行',NULL);
      INSERT INTO enterprise_source (id,module,business_table,version_key,channel_code,list_type_code,acquired_on,series,file_id,sha256)
        VALUES (71,'lead-lists','lead_list_version','11','research','lead','2026-11-18','走访名单',91,'${sourceSha}');
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
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      command('psql', ['-X', '-w', '-v', 'staging=lead_staging', '-f', `upgrade/postgresql/materialize-${name}.sql`], { env })
    }
    const stagedLogs = join(dir, 'staged-logs')
    const logs = createLogService({ directory: stagedLogs })
    try {
      await logs.policy()
    } finally {
      await logs.close()
    }
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', join(stagedLogs, 'events.db'), 'logs_staging'], { env })
    command('psql', ['-X', '-w', '-v', 'staging=logs_staging', '-f', 'upgrade/postgresql/materialize-runtime-logs.sql'], { env })
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
    expect(sources).toMatchObject([{ id: 71, fileId: 91, sha256: sourceSha, versionKey: '11' }])
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

    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '原资料现名', uscc: null, revision: 1 })
    expect((await (await app.request(`${versions}/12`)).json()).rows[0].enterpriseId).toBeNull()
    expect((await db.query('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=$1', [target.id])).rows).toEqual([])
    const sourcesPath = `/api/core/enterprises/${target.id}/sources`
    expect(await (await app.request(sourcesPath)).json()).toMatchObject([{ module: 'core' }])

    await db.query("INSERT INTO record(id,enterprise_id,title_code,source) VALUES (301,$1,'specialized_sme','jxj')", [target.id])
    await db.query("INSERT INTO record_event(id,record_id,event_type,year,batch_seq) VALUES (302,301,'award',2024,1)")

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
      max_decision_id: '0', fact_digest: hash(JSON.stringify(identityDigest)), head: true,
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
        VALUES (31,'并发名单甲','research','lead','2026-11-18',91,'${sourceSha}','concurrent-first','2026-11-18'),
               (32,'并发名单乙','research','lead','2026-11-18',91,'${sourceSha}','concurrent-second','2026-11-18');
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

  it('exports native lead rows and inherited titles as CSV through the durable job routes', async () => {
    const detail = await (await app.request(`${versions}/11`)).json()
    const linked = detail.rows[0].enterpriseId
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
    const result = await db.query(`INSERT INTO record(enterprise_id,title_code,source)
      VALUES ($1,'little_giant','jxj') RETURNING id`, [linked])
    const event = await db.query(`INSERT INTO record_event(record_id,event_type,year,batch_seq)
      VALUES ($1,'award',$2,1) RETURNING id`, [result.rows[0].id, year])
    await db.query("INSERT INTO record_evidence(record_event_id,source_file,list_no) VALUES ($1,'notice.pdf',1)", [event.rows[0].id])
    await db.query("UPDATE lead_list_row SET note='=1+1' WHERE id=102")
    await db.query("INSERT INTO lead_list_row (version_id,row_number,name) VALUES (11,1,'补录首行')")
    const snapshot = await (await app.request(`${versions}/11`)).json()
    expect(snapshot).toMatchObject({
      fileName: 'fixture.csv', fileAvailable: true,
      rows: [
        { rowNumber: 1, name: '补录首行', uscc: null, district: null, note: null, enterpriseId: null },
        { rowNumber: 2, name: '原始企业', enterpriseId: linked },
        { rowNumber: 3, name: '另一行', note: '=1+1', enterpriseId: null },
      ],
    })
    const base = '/api/lead-lists/exports'
    const request = { versionId: 11, clientRequestId: randomUUID() }
    const exportList = () => app.request(base, { method: 'POST', body: JSON.stringify(request) })
    const accepted = await exportList()
    const receipt = await accepted.json()
    expect(accepted.status, JSON.stringify(receipt)).toBe(202)
    expect(await (await exportList()).json()).toEqual(receipt)
    const job = await app.terminal(receipt.jobId)
    expect(job).toMatchObject({ kind: 'lead-lists-version-export', state: 'done', result: { versionId: 11, rowCount: 3 } })
    expect((await fetch(app.url(job.result.downloadUrl))).status).toBe(401)
    const download = await app.download(job.result.downloadUrl)
    expect(download.response.status).toBe(200)
    expect(download.response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(download.bytes.toString()).toBe([
      '\uFEFF"系列","获取日期","来源原件","原表序号","企业名称","统一社会信用代码","区县","备注","基础库企业编号","有效称号"',
      '"走访名单","2026-11-18","fixture.csv","1","补录首行","","","","",""',
      `"走访名单","2026-11-18","fixture.csv","2","原始企业","待核对","","","${linked}","专精特新“小巨人”、专精特新中小企业、创新型中小企业"`,
      '"走访名单","2026-11-18","fixture.csv","3","另一行","","","\'=1+1","",""',
      '',
    ].join('\r\n'))
  })

  it('registers verified source bytes and returns a missing-version 404 in PostgreSQL-only mode', async () => {
    const registered = await app.request(versions, {
      method: 'POST',
      body: JSON.stringify({
        series: '新登记名单', channel: 'research', listType: 'lead', acquiredOn: '2026-11-19',
        fileId: 91, rows: [{ rowNumber: 2, name: '新登记企业' }],
      }),
    })
    const receipt = await registered.json()
    expect(registered.status, JSON.stringify(receipt)).toBe(201)
    const catalog = await app.request(versions)
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toMatchObject({
      versions: expect.arrayContaining([expect.objectContaining({ id: receipt.id, series: '新登记名单', fileId: 91 })]),
    })
    const path = `${versions}/${receipt.id}/source`
    const download = await app.download(path)
    expect(download.response.status).toBe(200)
    expect(download.bytes).toEqual(sourceBytes)
    expect((await app.request(`${versions}/999999/source`)).status).toBe(404)
    expect(existsSync(join(dir, 'legacy-runtime'))).toBe(false)
    expect(existsSync(join(dir, 'legacy-logs'))).toBe(false)
  })
})
