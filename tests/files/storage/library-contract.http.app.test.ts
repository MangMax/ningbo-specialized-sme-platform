import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { minimalPdf } from '../../support/minimal-pdf'
import { startMiniOcrApi, type MiniOcrApi } from '../ocr/fixtures/provider-api'
import { readExactEvidence } from '../../../layers/sme-roster/server/utils/roster-evidence-correction'
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
  let provider: MiniOcrApi
  let originalEvidence: ReturnType<typeof readExactEvidence>
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
    provider = await startMiniOcrApi({ pages: ['识别出的业务名单'], submitStatuses: [400] })
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
        NUXT_POSTGRES_JOBS: postgres ? '1' : '0',
        NUXT_POSTGRES_ROSTER_READ: postgres ? '1' : '0',
        NUXT_POSTGRES_LEAD_REGISTRATION: postgres ? '1' : '0',
        NUXT_MCP_TOKEN: token,
        NUXT_OCR_TOKEN: 'local-ocr-fixture-token',
        NUXT_OCR_BASE_URL: provider.origin,
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
    db.prepare(`INSERT INTO ocr_result (id,file_id,page_no,revision,markdown,raw,engine,channel,created_at)
      VALUES (31,41,1,4,?,?,'paddleocr','api','2026-01-01T00:00:00.000Z')`)
      .run('历史 OCR 正文', JSON.stringify({ archived: true }))
    db.exec("UPDATE sqlite_sequence SET seq = 70 WHERE name = 'ocr_result'")
    db.exec(`
      INSERT INTO enterprise (id, name, name_norm) VALUES (1, '样例企业', '样例企业');
      INSERT INTO record (id, enterprise_id, title_code, source) VALUES (1, 1, 'specialized_sme', 'jxj');
      INSERT INTO record_event (id, record_id, event_type) VALUES (1, 1, 'award');
    `)
    const evidence = db.prepare('INSERT INTO record_evidence (record_event_id, source_file) VALUES (1, ?)')
    evidence.run(migratedPath)
    evidence.run('uploads/late-evidence.txt')
    db.exec(`
      INSERT INTO evidence_correction_batch (idempotency_key,request_hash,plan_hash,receipt,created_at)
      VALUES ('fixture-correction','fixture-request','fixture-plan','{"status":"committed"}','2026-01-01T00:01:00Z');
      INSERT INTO evidence_correction_audit (id,evidence_id,event_id,batch_key,entry_point,actor,basis,before,after,created_at)
      VALUES (33,1,1,'fixture-correction','correction','{"type":"agent","id":"reviewer"}','review','{}','{}','2026-01-01T00:01:00Z');
    `)
    const capture = db.prepare(`INSERT INTO official_evidence_row_revision
      (evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,name_raw,path,stored_file_id,sha256,
       source_binding_known,actor,basis,command_kind,correction_batch_key,created_at)
      VALUES (1,?,1,1,27,?,?,41,?,0,'{"type":"agent","id":"reviewer"}',?,'evidence_correction','fixture-correction','2026-01-01T00:01:00Z')`)
    capture.run(1, '原公布名称', migratedPath, sha256, '现场核对')
    capture.run(2, '  公布名称保留空格  ', migratedPath, sha256, 'fixture-secret ' + token)
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
    originalEvidence = readExactEvidence(app.db, 1)
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
      await app.resetBusiness()
    }
    await app.start()
  }, 120_000)

  afterAll(async () => {
    try { await app?.close() } finally {
      try {
        await provider?.close()
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

  async function tool(name: string, args: object) {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { ...app.headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    const data = body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body
    const { result } = JSON.parse(data)
    expect(result?.isError, data).not.toBe(true)
    return JSON.parse(result.content[0].text)
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

  it.skipIf(!enabled)('preserves published evidence coordinates, revisions and read limits across HTTP and MCP', async () => {
    const path = 'roster/evidence/1'
    expect(await json(path, 200)).toEqual(originalEvidence)
    expect((await app.request('/api/' + path + '?official=latest', { headers: {} })).status).toBe(401)
    const history = await json(path + '?official=history&pageSize=1', 200)
    expect(history.official).toMatchObject({
      availability: 'available', nextBeforeRevision: 2, rows: [{
        nameRaw: '  公布名称保留空格  ', revision: 2, capturedEnterpriseId: 27, currentOwner: { enterpriseId: 1, recordId: 1 },
        command: { kind: 'evidence_correction', batchKey: 'fixture-correction' },
      }],
    })
    expect(JSON.stringify(history.official)).not.toContain(token)
    expect(await tool('get_roster_evidence', { id: 1, official: 'history', pageSize: 1 })).toEqual(history)
    expect((await json(path + '?official=history&beforeRevision=2', 200)).official).toMatchObject({
      nextBeforeRevision: null, rows: [{ nameRaw: '原公布名称', revision: 1 }],
    })
    expect((await json('roster/evidence/2?official=latest', 200)).official).toMatchObject({ row: null, availability: 'unknown_legacy' })
    await json(path + '?official=latest&maxBytes=256', 413)
    expect(await tool('get_roster_evidence_audit', { id: 1 })).toEqual(await json(path + '/audit', 200))
    const receipt = await json('roster/evidence/corrections/batches/fixture-correction', 200)
    expect(receipt).toEqual({ status: 'committed' })
    expect(await tool('get_roster_evidence_correction_batch', { idempotencyKey: 'fixture-correction' })).toEqual(receipt)

    const event = await json('roster/events/1?official=latest', 200)
    expect(event).toMatchObject({ event: { eventType: 'award' }, files: [{ id: 41 }], official: {
      rows: [{ evidenceId: 1, revision: 2 }], nextAfterEvidenceId: null,
    } })
    expect(await tool('get_official_event', { eventId: 1, official: 'latest' })).toEqual(event)
    expect(await tool('get_event_correction_audit', { eventId: 1 })).toEqual(await json('roster/events/1/audit', 200))
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

  it.skipIf(!enabled)('shares file classification and maintenance receipts across MCP and HTTP', async () => {
    const ref = { relPath: migratedPath }
    expect(await tool('list_files', { source: 'jxj', pageSize: 1 })).toMatchObject({ total: 1, rows: [{ id: 41 }] })
    expect(await tool('get_file', ref)).toMatchObject({ id: 41, referenceCount: 1, contentIdentity: { status: 'verified' } })
    expect(await tool('list_file_parts', ref)).toMatchObject({
      file: { id: 41, relPath: migratedPath },
      parts: [{ attachment: '附件一', rowCount: 5 }, { attachment: null, rowCount: 1, origin: 'derived' }],
      partsBinding: { inputLineage: { status: 'bound', inputRef: { sha256 } } },
      contentIdentity: { status: 'verified' },
    })
    const { revision } = await json('files/41/maintenance', 200)
    const command = controls(revision, 'classify-across-transports')
    const { file } = await tool('set_file_category', { ...ref, ...command, year: 2026 })
    expect(file).toMatchObject({ id: 41, year: 2026, relPath: migratedPath, sha256 })
    expect(await json('files/41', 200, 'PATCH', { ...command, year: 2026 })).toEqual(file)
    expect(await tool('get_file_maintenance', { fileId: 41 })).toEqual(await json('files/41/maintenance', 200))
    expect(await tool('update_file', { fileId: 41, ...controls(revision + 1, 'correct-publication-year'), patch: { year: 2025 } }))
      .toMatchObject({ file: { id: 41, year: 2025 } })
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
    expect(await tool('remove_file', { fileId: 81, ...controls(1, 'remove') })).toMatchObject({ removed: true, diskDeleted: false })
    expect(await json('file-library?q=改名附件', 200)).toEqual({ rows: [], total: 0 })
    expect(readFileSync(join(root, relPath))).toEqual(original)
    expect(await json('files/81/restore', 200, 'POST', controls(2, 'restore'))).toMatchObject({ id: 81, removedAt: null })
    expect(await tool('restore_file', { fileId: 81, ...controls(2, 'restore') })).toMatchObject({ file: { id: 81, removedAt: null } })

    const deleted = await json('files/81?deleteDisk=1', 200, 'DELETE', controls(3, 'quarantine'))
    expect(deleted).toMatchObject({ removed: true, diskDeleted: false, diskQuarantined: true, intent: { fileId: 81, state: 'quarantined' } })
    expect(readFileSync(join(root, '.physical-quarantine', deleted.intent.id))).toEqual(original)
    const recovery = { ...controls(4, 'recover'), intentId: deleted.intent.id }
    const recovered = await json('files/81/physical-recovery', 200, 'POST', recovery)
    expect(recovered).toMatchObject({ removed: false, diskQuarantined: false, intent: { id: deleted.intent.id, state: 'recovered' } })
    expect(await json('files/81/physical-recovery', 200, 'POST', recovery)).toEqual(recovered)
    expect(await tool('recover_file', { fileId: 81, ...recovery })).toEqual(recovered)
    expect(await tool('quarantine_file', { fileId: 81, ...controls(3, 'quarantine') })).toEqual(deleted)
    expect(await json('files/81/physical-recovery', 200)).toMatchObject({ deleteReceipt: deleted, recoverReceipt: recovered })
    expect(await tool('get_file_physical_intent', { fileId: 81 })).toMatchObject({ deleteReceipt: deleted, recoverReceipt: recovered })
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

  it.skipIf(!enabled)('lists page images from a registered PDF without rendering', async () => {
    const relPath = 'uploads/pages.pdf'
    const pdf = minimalPdf({ pages: 2 })
    const hash = createHash('sha256').update(pdf).digest('hex')
    writeFileSync(join(root, relPath), pdf)
    const file = await json('files/register', 201, 'POST', { relPath })
    expect(await tool('list_page_images', { fileId: file.id })).toMatchObject({
      file: { id: file.id, relPath, contentIdentity: { status: 'verified', registered: { sha256: hash } } },
      pageCount: 2, rendered: 0, pages: [], manifest: null,
    })
  })

  it.skipIf(!enabled)('shares versioned OCR pages between HTTP and MCP without changing the original', async () => {
    expect(await json('ocr-results?fileId=41&includeVersion=1&markdown=1', 200)).toMatchObject({
      count: 1, pages: [{ page: 1, version: '31:4', markdown: '历史 OCR 正文', historicalBinding: { status: 'unknown' } }],
    })
    const relPath = 'uploads/ocr.pdf'
    const originalPdf = minimalPdf({ pages: 2 })
    writeFileSync(join(root, relPath), originalPdf)
    const file = await json('files/register', 201, 'POST', { relPath })
    const page = 'files/' + file.id + '/ocr-pages/1'
    await json(page, 200, 'PUT', { markdown: '原始名单', expectedVersion: null })
    const first = await json(page, 200)
    expect(first.markdown).toBe('<!-- page: 1 -->\n\n原始名单')
    expect(first.results[0].version).toBe('71:1')
    expect(await tool('get_ocr_result', { fileId: file.id, page: 1, includeVersion: true })).toEqual(first)
    await json(page, 409, 'PUT', { markdown: '过期写入', expectedVersion: null })

    await tool('save_ocr_result', { fileId: file.id, page: 1, markdown: '复核后的名单', expectedVersion: first.results[0].version })
    const updated = await json(page, 200)
    expect(updated.results[0].version).not.toBe(first.results[0].version)
    expect(updated.markdown).toBe('<!-- page: 1 -->\n\n复核后的名单')
    const exported = await app.request('/api/ocr-results/markdown?fileId=' + file.id)
    expect(exported.status).toBe(200)
    expect(await exported.text()).toBe(updated.markdown)
    await json(page, 409, 'DELETE', { expectedVersion: first.results[0].version })
    expect(await json(page, 200, 'DELETE', { expectedVersion: updated.results[0].version })).toMatchObject({ deleted: 1, remaining: 0 })
    await json(page, 404)
    expect(readFileSync(join(root, relPath))).toEqual(originalPdf)
  })

  it.skipIf(!enabled)('renders registered PDF pages through the durable batch task', async () => {
    const relPath = 'uploads/batch-render.pdf'
    const pdf = minimalPdf({ pages: 2 })
    writeFileSync(join(root, relPath), pdf)
    const file = await json('files/register', 201, 'POST', { relPath })
    const { jobId } = await json('jobs', 202, 'POST', { kind: 'render-pages', params: { files: [relPath], dpi: 72 } })
    const job = () => json('jobs/' + jobId, 200)
    await expect.poll(async () => {
      const value = await job()
      return ['done', 'failed'].includes(value.state) ? value : null
    }, { timeout: 10_000 }).toMatchObject({ state: 'done', result: { files: [
      { ok: true, file: relPath, contentIdentity: { fileId: file.id, sha256: file.sha256 }, rendered: 2, written: 2 },
    ] } })
    const pages = await tool('list_page_images', { fileId: file.id, dpi: 72 })
    expect(pages).toMatchObject({ pageCount: 2, rendered: 2, pages: [{ page: 1 }, { page: 2 }] })
    expect(readFileSync(join(root, relPath))).toEqual(pdf)
  })

  it.skipIf(!enabled)('publishes online OCR once and replays the published result after a rejected submission', async () => {
    const relPath = 'uploads/online-ocr.pdf'
    writeFileSync(join(root, relPath), minimalPdf({ pages: 1 }))
    const { id, sha256 } = await json('files/register', 201, 'POST', { relPath })
    const params = { files: [relPath] }
    async function run(kind: string, input: object, state: string) {
      const { jobId } = await json('jobs', 202, 'POST', { kind, params: input })
      const get = () => json('jobs/' + jobId, 200)
      await expect.poll(async () => (await get()).state, { timeout: 20_000 }).toBe(state)
      return { jobId, job: await get() }
    }

    await run('render-pages', { ...params, dpi: 300 }, 'done')
    const failed = await run('ocr', params, 'failed')
    expect(failed.job.result.files).toMatchObject([{ file: relPath, ok: false }])
    expect(provider.stats.submits).toBe(1)
    const page = 'files/' + id + '/ocr-pages/1'
    await json(page, 404)

    const published = await run('ocr', { ...params, resumeJobId: failed.jobId }, 'done')
    expect(published.job.result.files).toMatchObject([{ file: relPath, ok: true, pages: 1, apiJobIds: ['JOB-2'] }])
    const first = await json(page, 200)
    expect(first.markdown).toContain('识别出的业务名单')
    expect(first.results[0].historicalBinding).toMatchObject({ status: 'captured', input: { jobId: 'JOB-2', sourceSha256: sha256 } })

    await json(page, 200, 'PUT', { markdown: '人工核对后的名单', expectedVersion: first.results[0].version })
    const edited = await json(page, 200)
    const replay = await run('ocr', { ...params, resumeJobId: published.jobId }, 'done')
    expect(replay.job.result.files).toMatchObject([{ file: relPath, replayed: true, writtenPages: 0 }])
    expect(await json(page, 200)).toEqual(edited)
    expect(provider.stats.submits).toBe(2)
  }, 75_000)

  it.skipIf(!enabled)('registers a landed roster notice and audits factual refreshes without replacing its bytes', async () => {
    const relPath = 'jxj/announcement/2025/2/notice.txt'
    const declared = { relPath, source: 'jxj', kind: 'announcement', year: 2025, batch: 2 }
    const metadata = Object.entries({ filename: 'notice.txt', source: declared.source, kind: declared.kind, year: declared.year, batch: declared.batch })
      .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`).join(',')
    const upload = await app.request('/api/uploads', { method: 'POST', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Length': String(original.length), 'Upload-Metadata': metadata,
    } })
    expect(upload.status, await upload.text()).toBe(201)
    const landed = await fetch(new URL(upload.headers.get('location')!, app.url('/')), { method: 'PATCH', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, body: original })
    expect(landed.status, await landed.text()).toBe(204)
    expect(decodeURIComponent(landed.headers.get('x-upload-path')!)).toBe(relPath)
    await json('files/register', 400, 'POST', { ...declared, batch: 3 })
    const submissions = await Promise.all([1, 2].map(() => app.request('/api/files/register', { method: 'POST', body: JSON.stringify(declared) })))
    expect(submissions.map(response => response.status).sort()).toEqual([200, 201])
    const [registered, repeated] = await Promise.all(submissions.map(response => response.json()))
    expect(registered).toMatchObject({
      ...declared, sha256, categoryState: 'set', parseState: 'unparsed', parts: [],
    })
    const id = registered.id
    expect(repeated).toMatchObject({ id })
    expect(await json(`files/${id}/maintenance`, 200)).toMatchObject({ revision: 0 })
    await json(`files/${id}`, 200, 'PATCH', { year: null, ...controls(0, 'clear-roster-notice-year') })
    expect(await json('files/register', 200, 'POST', declared)).toMatchObject({ id, year: 2025, categoryState: 'set' })
    const history = await json(`files/${id}/maintenance`, 200)
    expect(history.revision).toBe(2)
    expect(history.rows.at(-1)).toMatchObject({ mode: 'legacy', before: { year: null }, after: { year: 2025 } })
    writeFileSync(join(root, relPath), 'changed bytes')
    try {
      await json('files/register', 409, 'POST', declared)
      expect(await json(`files/${id}/maintenance`, 200)).toMatchObject({ revision: 2, file: { sha256 } })
    } finally { writeFileSync(join(root, relPath), original) }
  })

  it.skipIf(!enabled)('uses frozen OCR input for parse declarations and shares replay receipts across transports', async () => {
    const previous = await json('files/41/parse-result', 200)
    expect(previous).toMatchObject({ parts: expect.arrayContaining([expect.objectContaining({ rowCount: 5, hasConflict: true })]), ingestionStatistics: { rowCount: 1 },
      declarations: [{ declarationId: 'active-declaration' }] })
    expect(await tool('get_file_parse_result', { fileId: 41 })).toEqual(previous)
    const relPath = 'jxj/announcement/2025/3/parse.pdf'
    mkdirSync(join(root, 'jxj/announcement/2025/3'), { recursive: true })
    const pdf = minimalPdf({ pages: 2 })
    writeFileSync(join(root, relPath), pdf)
    const { id } = await json('files/register', 201, 'POST', { relPath, source: 'jxj', kind: 'announcement', year: 2025, batch: 3 })
    const path = 'files/' + id + '/parse-result'
    const page = 'files/' + id + '/ocr-pages/1'
    await json(page, 200, 'PUT', { markdown: '旧名单', expectedVersion: null })
    const version = async () => (await json(page, 200)).results[0].version
    const preflight = (pageVersion: string) => json(path + '/preflight', 200, 'POST', {
      kind: 'ocr', pages: [{ page: 1, version: pageVersion }], verifyPhysicalPages: true,
    })
    const initial = await version()
    const stale = await preflight(initial)
    expect(stale.inputRef.physicalSource.pageCount).toBe(2)
    const parts = [{ titleCode: 'specialized_sme', eventKind: 'award', year: 2025, batch: 3,
      attachment: '附 件 1', rowCount: 2, pageRanges: [{ start: 1, end: 2 }] }]
    const fields = { idempotencyKey: 'frozen-parse', actor: { type: 'agent', id: 'fixture' }, reason: '核对过原文', parts }
    await json(page, 200, 'PUT', { markdown: '正式名单', expectedVersion: initial })
    await json(path + '/commit', 409, 'POST', { ...fields, ...stale })
    const command = { ...fields, ...await preflight(await version()) }
    const saved = await tool('commit_file_parse_result', { fileId: id, ...command })
    expect(saved).toMatchObject({ replayed: false, state: {
      parseState: 'parsed', parts: [{ attachment: '附件1', origin: 'agent', hasConflict: false }],
      declarations: [{ displaySequence: 1, revision: 1, pageRanges: [{ start: 1, end: 2 }] }],
      inputLineage: { status: 'bound', inputRef: command.inputRef },
    } })
    expect(await json(path, 200)).toEqual(saved.state)
    const replay = await json(path + '/commit', 200, 'POST', command)
    expect(replay).toEqual({ ...saved, replayed: true })
    const history = await tool('get_file_parse_history', { fileId: id, receiptId: saved.receiptId })
    expect(history).toMatchObject({ id: saved.receiptId, after: saved.state, before: { parseState: 'unparsed', parts: [] } })
    const corrected = await json(path, 200, 'PATCH', {
      expectedVersion: saved.state.version, idempotencyKey: 'parse-status', actor: fields.actor, reason: fields.reason, parseState: 'failed',
    })
    expect(corrected.state).toMatchObject({ parseState: 'failed', parts: saved.state.parts, inputLineage: saved.state.inputLineage })
    expect((await json(page, 200)).markdown).toBe('<!-- page: 1 -->\n\n正式名单')
    expect(readFileSync(join(root, relPath))).toEqual(pdf)
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
      const waitForRowLock = (count: number) => vi.waitFor(async () => {
        await connection.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await connection.query(
          `WITH RECURSIVE blocked(pid) AS (
            SELECT pg_backend_pid()
            UNION
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
            WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock'
          )
          SELECT pid FROM blocked WHERE pid <> pg_backend_pid()`,
        )
        expect(rows).toHaveLength(count)
      }, { timeout: 3000 })
      try {
        await connection.query('BEGIN')
        await connection.query('SELECT id FROM business.stored_file WHERE id = $1 FOR UPDATE', [id])
        pending.push(json('lead-lists/versions', 201, 'POST', lead))
        await waitForRowLock(1)
        pending.push(json(quarantine, 409, 'DELETE', controls(0, 'protect-live-lead-source')))
        await waitForRowLock(2)
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

  it.skipIf(!enabled)('fills only missing official event dates from verified PDF ranges and replays the chunk', async () => {
    const relPath = 'jxj/announcement/2025/4/sync.pdf'
    mkdirSync(join(root,'jxj/announcement/2025/4'),{recursive:true})
    const pdf = minimalPdf({ pages:1 })
    writeFileSync(join(root,relPath),pdf)
    const { id } = await json('files/register',201,'POST',{relPath,source:'jxj',kind:'announcement',year:2025,batch:4})
    const fixture = `
      INSERT INTO enterprise(id,name,name_norm) VALUES(900001,'合成同步主体','合成同步主体');
      INSERT INTO record(id,enterprise_id,title_code,source) VALUES(900001,900001,'specialized_sme','jxj');
      INSERT INTO record_event(id,record_id,event_type) VALUES(900001,900001,'award');
      INSERT INTO record_evidence(id,record_event_id,source_file,page,attachment) VALUES(900001,900001,'${relPath}',1,'附件1');`
    if (postgres) runPg('psql',['-X','-w','-q','-v','ON_ERROR_STOP=1','-c','SET search_path TO business; '+fixture])
    else app.db.$client.exec(fixture)
    const path = 'files/'+id
    const source = await json(path+'/parse-result/preflight',200,'POST',{ kind:'file',verifyPhysicalPages:true })
    const actor = { type:'agent',id:'fixture' }
    const declaration = { idempotencyKey:'pdf-event-sync-declaration',actor,reason:'核对合成文件的第一物理页',
      parts:[{titleCode:'specialized_sme',eventKind:'award',year:2025,batch:4,attachment:'附件1',rowCount:1,pageRanges:[{start:1,end:1}]}],...source }
    await json(path+'/parse-result/commit',200,'POST',declaration)
    const request = { idempotencyKey:'pdf-event-sync',actor,basis:'根据已保存的合成分段补齐年月' }
    const plan = await json(path+'/event-sync/preflight',200,'POST',request)
    expect(plan).toMatchObject({ chunks:1,counts:{updated:0,conflicts:0,unexecuted:1},
      rows:[{eventId:900001,status:'update',before:{year:null,batchSeq:null},after:{year:2025,batchSeq:4}}] })
    const command = { request,planHash:plan.planHash,chunk:0 }
    const [first,second] = await Promise.all([json(path+'/event-sync/commit',200,'POST',command),json(path+'/event-sync/commit',200,'POST',command)])
    expect(second).toEqual(first)
    expect(first).toMatchObject({ completed:[0],counts:{updated:1,conflicts:0,unexecuted:0} })
    expect(await json('roster/events/900001',200)).toMatchObject({ event: { id:900001,year:2025,batchSeq:4,revision:2 } })
    expect(readFileSync(join(root,relPath))).toEqual(pdf)
  })

})
