import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'

const pgBin = process.env.TEST_FILE_LIBRARY_PG_BIN
const cwd = resolve(import.meta.dirname, '../../..')
const original = Buffer.from('原始附件\nfile library contract\n')
const sha256 = createHash('sha256').update(original).digest('hex')
const migratedPath = 'uploads/原始.TXT'
const token = 'file-library-fixture-token'
const controls = (expectedRevision: number, idempotencyKey: string) => ({
  expectedRevision, idempotencyKey, actor: 'fixture', basis: 'file library HTTP contract',
})

describe.each(['SQLite', 'PostgreSQL'] as const)('%s file library HTTP contract', engine => {
  const postgres = engine === 'PostgreSQL'
  const enabled = !postgres || Boolean(pgBin)
  let dir: string
  let root: string
  let app: ReturnType<typeof nativeAppAdapter>
  let pgStarted = false
  let pgUrl: string
  let pgEnv: NodeJS.ProcessEnv

  const runPg = (program: string, args: string[]) =>
    execFileSync(join(pgBin!, program), args, { cwd, env: pgEnv, encoding: 'utf8' })

  beforeAll(async () => {
    if (!enabled) return
    // Keep the socket path short enough for PostgreSQL on macOS.
    dir = mkdtempSync('/tmp/file-pg-')
    root = join(dir, 'files')
    mkdirSync(join(root, 'uploads'), { recursive: true })
    writeFileSync(join(root, migratedPath), original)
    app = nativeAppAdapter({ dir, token, launch: ({ cwd, port }) => {
      if (port === 3482) throw new Error('Reserved production port')
      return { args: [join(cwd, '.output/server/index.mjs')], env: {
        NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
        NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
        NUXT_LOG_DIR: join(dir, 'logs'),
        NUXT_DB_READONLY: postgres ? '1' : '0',
        NUXT_POSTGRES_LOG_URL: '',
        NUXT_POSTGRES_DIRECTORY_URL: postgres ? pgUrl : '',
        NUXT_POSTGRES_DIRECTORY_WRITE: postgres ? '1' : '0',
        NUXT_POSTGRES_FILE_LIBRARY: postgres ? '1' : '0',
        NUXT_POSTGRES_LEAD_REGISTRATION: postgres ? '1' : '0',
      } }
    } })
    const discovery = await readDevelopmentDiscovery()
    expect(discovery.paths['/api/files/register'].post.responses['201']).toBeDefined()
    expect(discovery.paths['/api/files/{id}/physical-recovery'].post).toBeDefined()
    const db = app.db.$client
    db.transaction(() => installLeadListSchema(db))()
    db.prepare('INSERT INTO stored_file VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      41, migratedPath, '历史附件', '原始.TXT', 'txt', original.length, sha256, '2026-01-01T00:00:00.000Z', null,
    )
    db.exec("UPDATE sqlite_sequence SET seq = 80 WHERE name = 'stored_file'")
    db.exec(`
      INSERT INTO enterprise (id, name, name_norm) VALUES (1, '样例企业', '样例企业');
      INSERT INTO record (id, enterprise_id, title_code, source) VALUES (1, 1, 'specialized_sme', 'jxj');
      INSERT INTO record_event (id, record_id, event_type) VALUES (1, 1, 'award');
    `)
    const evidence = db.prepare('INSERT INTO record_evidence (record_event_id, source_file) VALUES (1, ?)')
    evidence.run(migratedPath)
    evidence.run('uploads/late-evidence.txt')
    db.exec(`
      INSERT INTO roster_file_classification (file_id, source, kind, year, batch, title_code, category_state, parse_state)
      VALUES (41, 'jxj', 'announcement', 2025, 2, 'specialized_sme', 'set', 'parsed');
      INSERT INTO stored_file_part (file_id, title_code, event_kind, year, batch, attachment, row_count, origin, has_conflict)
      VALUES (41, 'specialized_sme', 'award', 2024, 1, '附件一', 5, 'derived', 1);
    `)
    const declaration = db.prepare(`INSERT INTO file_declaration_669 (declaration_id, file_id, revision, active, sha256, part, page_ranges)
      VALUES (?, 41, 1, ?, ?, ?, ?)`)
    for (const [id, active] of [['active-declaration', 1], ['inactive-declaration', 0]] as const) {
      declaration.run(id, active, sha256, JSON.stringify({ titleCode: 'specialized_sme', eventKind: 'award', year: 2024,
        batch: 1, attachment: '附件一', rowCount: 5 }), JSON.stringify([{ start: 1, end: 2 }]))
    }
    db.prepare(`INSERT INTO file_parse_audit_105
      (file_id,idempotency_key,request_hash,operation,actor,reason,before,after,created_at)
      VALUES (41, 'fixture-lineage', 'fixture-hash', 'replace', ?, 'test', '{}', ?, '2026-01-01T00:00:00Z')`)
      .run(JSON.stringify({ type: 'agent', id: 'fixture' }), JSON.stringify({ inputLineage: { status: 'bound', inputRef: { sha256 } } }))
    db.prepare(`INSERT INTO file_maintenance_audit
      (id, file_id, revision, action, request_hash, mode, before_json, after_json, created_at)
      VALUES (23, 41, 1, 'update', ?, 'legacy', ?, ?, '2026-01-01T00:01:00.000Z')`).run(
      'historical-hash', '{ "displayName": "原始.TXT" }', '{ "displayName": "历史附件" }',
    )
    db.exec("UPDATE sqlite_sequence SET seq = 90 WHERE name = 'file_maintenance_audit'")
    if (postgres) {
      pgEnv = {
        PATH: process.env.PATH, LANG: 'C', PGHOST: dir, PGPORT: '5432',
        PGDATABASE: 'postgres', PGUSER: 'file_contract', PGSQL_BIN: join(pgBin!, 'psql'),
      }
      runPg('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'file_contract', '-D', join(dir, 'pg')])
      runPg('pg_ctl', ['-w', '-D', join(dir, 'pg'), '-l', join(dir, 'pg.log'), '-o', `-c listen_addresses='' -k ${dir}`, 'start'])
      pgStarted = true
      pgUrl = `postgresql://file_contract@localhost/postgres?host=${encodeURIComponent(dir)}`
      execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', app.dbPath, 'staged'], { cwd, env: pgEnv, stdio: 'pipe' })
      for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
        runPg('psql', ['-X', '-w', '-q', '-v', 'staging=staged', '-f', `upgrade/postgresql/materialize-${name}.sql`])
      }
      // The companion SQLite stays a valid but empty app database. A SQLite
      // fallback cannot pass the migrated-file or new-write assertions.
      await app.resetBusiness()
    }
    await app.start()
  }, 120_000)

  afterAll(async () => {
    try { await app?.close() } finally {
      try {
        if (pgStarted) runPg('pg_ctl', ['-w', '-m', 'fast', '-D', join(dir, 'pg'), 'stop'])
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  async function json(path: string, status: number, method = 'GET', body?: unknown) {
    const response = await app.request('/api/' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(status)
    return value
  }
  it.skipIf(!enabled)('reads scoped roster metadata and keeps global file rows free of roster fields', async () => {
    const filtered = await json('sme-roster/files?source=jxj&parseState=parsed&pageSize=1', 200)
    expect(filtered).toMatchObject({ total: 1, rows: [{
      id: 41, source: 'jxj', kind: 'announcement', year: 2025, batch: 2, titleCode: 'specialized_sme',
      categoryState: 'set', parseState: 'parsed', referenceCount: 1,
      parts: [{ titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 1, attachment: '附件一', rowCount: 5, origin: 'derived', hasConflict: true }],
      registeredSummary: { count: 1, declarations: [{ declarationId: 'active-declaration', active: true, sha256, pageRanges: [{ start: 1, end: 2 }] }] },
      partsBinding: { historical: 'unknown', inputLineage: { status: 'bound', inputRef: { sha256 } } },
    }] })
    expect(await json('sme-roster/files?source=miit', 200)).toEqual({ rows: [], total: 0 })
    expect(await json('sme-roster/files?page=2&pageSize=1', 200)).toEqual({ rows: [], total: 1 })
    expect(await json('files?source=jxj&parseState=parsed', 200)).toEqual(filtered)
    const global = await json('file-library', 200)
    expect(global.total).toBe(1)
    expect(global.rows[0]).not.toHaveProperty('categoryState')
    expect(global.rows[0]).not.toHaveProperty('parts')
  })

  it.skipIf(!enabled)('preserves migrated file identity and serves original, HEAD and range bytes', async () => {
    const file = { id: 41, relPath: migratedPath, displayName: '历史附件', filename: '原始.TXT', bytes: original.length, sha256 }
    expect(await json('file-library?q=原始.txt&pageSize=1', 200)).toMatchObject({ rows: [file], total: 1 })
    expect(await json('files/41/maintenance', 200)).toMatchObject({
      file: { ...file, referenceCount: 1 }, revision: 1,
      rows: [{ id: 23, revision: 1, requestHash: 'historical-hash', before: { displayName: '原始.TXT' }, after: { displayName: '历史附件' } }],
    })
    expect(await json('files?q=原始.txt', 200)).toMatchObject({ rows: [{ ...file, referenceCount: 1 }], total: 1 })
    const response = await app.request('/api/files/41')
    expect(response.headers.get('x-file-sha256')).toBe(sha256)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original)
    const head = await app.request('/api/files/41', { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe(String(original.length))
    expect(await head.text()).toBe('')
    const partial = await app.request('/api/files/' + encodeURI(migratedPath), { headers: { Range: 'bytes=0-2' } })
    expect(partial.status).toBe(206)
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(original.subarray(0, 3))
    writeFileSync(join(root, migratedPath), Buffer.alloc(original.length, 0x61))
    try {
      expect(await json('files/41', 409)).toMatchObject({ data: { code: 'file_content_conflict', fileId: 41 } })
    } finally { writeFileSync(join(root, migratedPath), original) }
    await json('files/41?deleteDisk=1', 409, 'DELETE', controls(1, 'protect-official-evidence'))
    expect(await json('files/41', 200, 'DELETE', controls(1, 'soft-remove-official-evidence'))).toMatchObject({ referenceCount: 1, removed: true })
    // History remains addressable after soft removal.
    expect(Buffer.from(await (await app.request('/api/files/41')).arrayBuffer())).toEqual(original)
    await json('files/41/restore', 200, 'POST', controls(2, 'restore-official-evidence'))
    expect(await json('files/41/maintenance', 200)).toMatchObject({ rows: [{ id: 23 }, { id: 91 }, { id: 92 }] })
  })

  it.skipIf(!enabled)('edits roster classification, preserves source bytes and keeps one audit per revision', async () => {
    const { revision } = await json('files/41/maintenance', 200)
    const patch = { ...controls(revision, 'clear-publication-year'), year: null }
    const cleared = await json('files/41', 200, 'PATCH', patch)
    expect(cleared).toMatchObject({
      id: 41, relPath: migratedPath, sha256, source: 'jxj', kind: 'announcement', year: null,
      batch: 2, categoryState: 'unset', parseState: 'parsed', referenceCount: 1,
    })
    expect(await json('files/41', 200, 'PATCH', patch)).toEqual(cleared)
    await json('files/41', 409, 'PATCH', { ...controls(revision, 'stale-classification'), year: 2026 })
    const history = await json('files/41/maintenance', 200)
    expect(history.revision).toBe(revision + 1)
    expect(history.rows.at(-1)).toMatchObject({
      revision: revision + 1, before: { year: 2025, categoryState: 'set' },
      after: { year: null, categoryState: 'unset' },
    })
    expect(await json('sme-roster/files?categoryState=unset', 200)).toMatchObject({
      total: 1, rows: [{ id: 41, year: null }],
    })
    expect(await json('files/41', 200, 'PATCH', { year: 2025 })).toMatchObject({ categoryState: 'set', year: 2025 })
    expect(await json('files/41', 200, 'PATCH', { year: 2025 })).toMatchObject({ categoryState: 'set', year: 2025 })
    expect(await json('files/41/maintenance', 200)).toMatchObject({ revision: revision + 2 })
    expect(Buffer.from(await (await app.request('/api/files/41')).arrayBuffer())).toEqual(original)
  })

  it.skipIf(!enabled)('registers a landed upload once and preserves identity through maintenance and recovery', async () => {
    const filename = '新附件.txt'
    const create = await app.request('/api/uploads', { method: 'POST', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Length': String(original.length),
      'Upload-Metadata': `filename ${Buffer.from(filename).toString('base64')},fileCategory Y29yZQ==`,
    } })
    expect(create.status).toBe(201)
    const upload = await fetch(new URL(create.headers.get('location')!, app.url('/')), { method: 'PATCH', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, body: new Uint8Array(original) })
    expect(upload.status).toBe(204)
    const relPath = decodeURIComponent(upload.headers.get('x-upload-path')!)
    expect(relPath).toBe('uploads/新附件.txt')
    const file = await json('files/register', 201, 'POST', { relPath, fileCategory: 'core' })
    expect(file).toMatchObject({ id: 81, relPath, sha256, bytes: original.length })
    expect(await json('files/register', 200, 'POST', { relPath })).toEqual(file)

    const rename = { ...controls(0, 'rename'), displayName: '改名附件' }
    const renamed = await json('files/81', 200, 'PATCH', rename)
    expect(renamed).toMatchObject({ id: 81, relPath, sha256, displayName: '改名附件' })
    expect(await json('files/81', 200, 'PATCH', rename)).toEqual(renamed)
    await json('files/81', 409, 'PATCH', { ...rename, displayName: '不同请求' })
    await json('files/81', 409, 'PATCH', { ...controls(0, 'stale'), displayName: '旧版本' })

    expect(await json('files/81', 200, 'DELETE', controls(1, 'remove'))).toMatchObject({ removed: true, diskDeleted: false, referenceCount: 0 })
    expect(await json('file-library?q=改名附件', 200)).toEqual({ rows: [], total: 0 })
    expect(readFileSync(join(root, relPath))).toEqual(original)
    expect(await json('files/81/restore', 200, 'POST', controls(2, 'restore'))).toMatchObject({ id: 81, removedAt: null })

    const deleted = await json('files/81?deleteDisk=1', 200, 'DELETE', controls(3, 'quarantine'))
    expect(deleted).toMatchObject({ removed: true, diskDeleted: false, diskQuarantined: true, intent: { fileId: 81, state: 'quarantined' } })
    expect(readFileSync(join(root, '.physical-quarantine', deleted.intent.id))).toEqual(original)
    const recovery = { ...controls(4, 'recover'), intentId: deleted.intent.id }
    const recovered = await json('files/81/physical-recovery', 200, 'POST', recovery)
    expect(recovered).toMatchObject({ removed: false, diskQuarantined: false, intent: { id: deleted.intent.id, state: 'recovered' } })
    expect(await json('files/81/physical-recovery', 200, 'POST', recovery)).toEqual(recovered)
    expect(await json('files/81?deleteDisk=1', 200, 'DELETE', controls(3, 'quarantine'))).toEqual(deleted)
    expect(await json('files/81/physical-recovery', 200)).toMatchObject({ deleteReceipt: deleted, recoverReceipt: recovered })
    expect(await json('files/81/maintenance?page=2&pageSize=2', 200)).toMatchObject({
      file: { id: 81, relPath, sha256, removedAt: null }, revision: 5, total: 5,
      rows: [{ revision: 3, action: 'restore' }, { revision: 4, action: 'remove' }],
    })
    expect(readFileSync(join(root, relPath))).toEqual(original)
  })
  it.skipIf(!enabled)('protects historical evidence for paths registered after materialization', async () => {
    const relPath = 'uploads/late-evidence.txt'
    writeFileSync(join(root, relPath), original)
    const { id } = await json('files/register', 201, 'POST', { relPath })
    expect(await json(`files/${id}/maintenance`, 200)).toMatchObject({ file: { referenceCount: 1 } })
    await json(`files/${id}?deleteDisk=1`, 409, 'DELETE', controls(0, 'protect-late-evidence'))
    expect(readFileSync(join(root, relPath))).toEqual(original)
  })

  it.skipIf(!enabled)('protects current roster references added after file registration', async () => {
    const relPath = 'uploads/current-roster-evidence.txt'
    writeFileSync(join(root, relPath), original)
    const { id } = await json('files/register', 201, 'POST', { relPath })
    expect(await json(`files/${id}/maintenance`, 200)).toMatchObject({ file: { referenceCount: 0 } })
    if (postgres) {
      runPg('psql', ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
        "INSERT INTO business.record_evidence (record_event_id, source_file) VALUES (1, 'uploads/current-roster-evidence.txt')"])
    } else {
      app.db.$client.prepare('INSERT INTO record_evidence (record_event_id, source_file) VALUES (1, ?)').run(relPath)
    }
    expect(await json(`files/${id}/maintenance`, 200)).toMatchObject({ file: { referenceCount: 1 } })
    await json(`files/${id}?deleteDisk=1`, 409, 'DELETE', controls(0, 'protect-current-roster-evidence'))
    expect(readFileSync(join(root, relPath))).toEqual(original)
  })

  it.skipIf(!enabled)('recovers original bytes after an audit failure following quarantine and recovery moves', async () => {
    const relPath = 'uploads/recovery.txt'
    writeFileSync(join(root, relPath), original)
    const { id } = await json('files/register', 201, 'POST', { relPath })
    const path = `files/${id}`
    const quarantine = controls(0, 'quarantine-after-failure')
    const inject = postgres
      ? `CREATE FUNCTION business.reject_test_file_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test audit failure'; END; $$;
          CREATE TRIGGER reject_test_file_audit BEFORE INSERT ON business.file_maintenance_audit
          FOR EACH ROW EXECUTE FUNCTION business.reject_test_file_audit();`
      : "CREATE TRIGGER reject_test_file_audit BEFORE INSERT ON file_maintenance_audit BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;"
    const remove = postgres
      ? 'DROP TRIGGER reject_test_file_audit ON business.file_maintenance_audit; DROP FUNCTION business.reject_test_file_audit()'
      : 'DROP TRIGGER reject_test_file_audit'
    const query = (sql: string) => postgres ? runPg('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-c', sql]) : app.db.$client.exec(sql)

    query(inject)
    try {
      await json(path + '?deleteDisk=1', 500, 'DELETE', quarantine)
      const pending = await json(path + '/physical-recovery', 200)
      expect(pending).toMatchObject({ removed: false, intent: { state: 'pending' }, deleteReceipt: null })
      expect(existsSync(join(root, relPath))).toBe(false)
      expect(readFileSync(join(root, '.physical-quarantine', pending.intent.id))).toEqual(original)
      expect(await json(path + '/maintenance', 200)).toMatchObject({ total: 0, revision: 0 })
    } finally { query(remove) }

    const deleted = await json(path + '?deleteDisk=1', 200, 'DELETE', quarantine)
    const recovery = { intentId: deleted.intent.id, ...controls(1, 'recover-after-failure') }
    query(inject)
    try {
      await json(path + '/physical-recovery', 500, 'POST', recovery)
      expect(await json(path + '/physical-recovery', 200)).toMatchObject({
        intent: { state: 'recovering' }, deleteReceipt: deleted, recoverReceipt: null,
      })
      expect(await json(path + '/maintenance', 200)).toMatchObject({ total: 1, revision: 1, file: { removedAt: expect.any(String) } })
      expect(readFileSync(join(root, relPath))).toEqual(original)
    } finally { query(remove) }

    await json(path + '/physical-recovery', 200, 'POST', recovery)
    expect(await json(path + '/maintenance', 200)).toMatchObject({ total: 2, revision: 2, file: { removedAt: null } })
    expect(readFileSync(join(root, relPath))).toEqual(original)
  })

  it.skipIf(!enabled)('counts live lead registrations and rejects moving a referenced original', async () => {
    const relPath = 'uploads/lead.csv'
    writeFileSync(join(root, relPath), original)
    const { id } = await json('files/register', 201, 'POST', { relPath })
    const lead = { series: '调研', channel: 'research', listType: 'lead', acquiredOn: '2026-11-18',
      fileId: id, rows: [{ rowNumber: 2, name: '样例企业' }] }
    const quarantine = `files/${id}?deleteDisk=1`
    if (postgres) {
      const connection = new pg.Client({ connectionString: pgUrl })
      await connection.connect()
      const pending: Promise<unknown>[] = []
      const waitForRowLock = (part: string) => vi.waitFor(async () => {
        await connection.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await connection.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [part],
        )
        expect(rows).toHaveLength(1)
      }, { timeout: 3000 })
      try {
        await connection.query('BEGIN')
        await connection.query('SELECT id FROM business.stored_file WHERE id = $1 FOR UPDATE', [id])
        pending.push(json('lead-lists/versions', 201, 'POST', lead))
        await waitForRowLock('%FROM stored_file f WHERE f.id =%FOR UPDATE%')
        pending.push(json(quarantine, 409, 'DELETE', controls(0, 'protect-live-lead-source')))
        await waitForRowLock('%SELECT id FROM stored_file WHERE id =%FOR UPDATE%')
        await connection.query('COMMIT')
        await Promise.all(pending)
      } finally {
        await connection.query('ROLLBACK')
        await connection.end()
        await Promise.allSettled(pending)
      }
    } else {
      await json('lead-lists/versions', 201, 'POST', lead)
      await json(quarantine, 409, 'DELETE', controls(0, 'protect-live-lead-source'))
    }
    expect(await json('files?leadListUsage=source', 200)).toMatchObject({ rows: [{ id, referenceCount: 1 }], total: 1 })
    await json(`files/${id}/physical-recovery`, 404)
    expect(readFileSync(join(root, relPath))).toEqual(original)
  })

})
