import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import { compareCurrentReadAuthority } from '../scripts/lib/benchmark-authority.mjs'

// This file checks a frozen input contract, NOT the product reader or D3 responses.
// Ordinary tests use tracked canonical migrations and never need a local delivery.
// External artifact acceptance is a separately named, explicit opt-in test below.
const delivery = process.env.H1B_ARTIFACT_DELIVERY_DIR
const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const bytes = readFileSync(new URL('../scripts/fixtures/platform-query-current-authority.json', import.meta.url))
const document = JSON.parse(bytes.toString())
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown) => sha(JSON.stringify(value))
const load = (file: string) => {
  assert.ok(delivery, 'External artifact delivery requires H1B_ARTIFACT_DELIVERY_DIR')
  return JSON.parse(readFileSync(join(delivery, file), 'utf8'))
}
const copy = <T>(value: T): T => structuredClone(value)
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'

function artifactInput() {
  assert.ok(delivery, 'External artifact delivery requires H1B_ARTIFACT_DELIVERY_DIR')
  const raw = readFileSync(join(delivery, 'artifact-manifest.json'))
  assert.equal(sha(raw), document.artifactManifestSha256)
  const artifact = JSON.parse(raw.toString())
  const acceptance = load('parent-acceptance.json')
  assert.equal(acceptance.status, 'ACCEPTED_ARTIFACT_DELIVERY_ONLY')
  assert.equal(acceptance.artifactManifestSha256, sha(raw))
  assert.equal(sha(readFileSync(join(delivery, 'receipt.json'))), artifact.identity.buildReceiptSha256)
  assert.equal(sha(readFileSync(join(delivery, 'artifact-inventory.json'))), artifact.identity.outputManifestSha256)
  assert.equal(sha(readFileSync(join(delivery, 'dependency-inventory.json'))), artifact.identity.dependencyManifestSha256)
  const journalBytes = readFileSync(join(delivery, 'migrations/meta/_journal.json'))
  assert.equal(sha(journalBytes), artifact.identity.journalSha256)
  const journal = JSON.parse(journalBytes.toString()).entries
  assert.equal(journal.length, 44)
  assert.deepEqual(journal.map((e: any) => ({ tag: e.tag, when: e.when,
    sqlSha256: sha(readFileSync(join(delivery, 'migrations', e.tag + '.sql'))) })), artifact.identity.journal)
  assert.equal(artifact.identity.sourceSha, '1d4a4a3508093c5d1d4bc9c289a19cf3fec2ceb4')
  assert.equal(artifact.identity.sourceTree, '95dcf29698d1a9d5c0f68d16a2bcec6266890707')
  return { ...artifact, lane: 'current-read', schemaVersion: 1, manifestSha256: sha(raw) }
}

function withSeed<T>(doc: any, check: (db: Database.Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'issue-621-synthetic-'))
  const db = new Database(join(dir, 'synthetic.sqlite'))
  try {
    db.pragma('foreign_keys = ON')
    migrate(drizzle(db), { migrationsFolder: migrations })
    for (const [table, rows] of Object.entries(doc.seed) as [string, any[]][]) {
      for (const row of rows) {
        const columns = Object.keys(row)
        db.prepare(`insert into ${quote(table)} (${columns.map(quote)}) values (${columns.map(() => '?')})`).run(...Object.values(row))
      }
    }
    return check(db)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}

// Stable logical whole-database digest, explicitly NOT the physical SQLite bytes.
function logicalDatabase(db: Database.Database) {
  const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as { name: string }[]
  return tables.map(({ name }) => {
    const columns = (db.prepare(`pragma table_info(${quote(name)})`).all() as { name: string }[]).map(c => c.name).sort()
    const rows = db.prepare(`select ${columns.map(quote)} from ${quote(name)}`).all()
      .map(row => columns.map(c => (row as any)[c])).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))
    return [name, columns, rows]
  })
}

function validate(doc: any, db: Database.Database) {
  assert.equal(doc.lane, 'current-read')
  assert.equal(doc.schemaVersion, 1)
  assert.equal(doc.workloadId, 'h1b-small-synthetic-v1')
  assert.deepEqual(doc.qualification, { runtimeQualified: false, originalScale: 'UNVALIDATED/rejected', originalQueryRows: 39303, originalRelationRows: 58310 })
  assert.equal(digest(doc.seed), doc.bindings.seedSha256)
  assert.equal(digest(doc.scenarios.map((s: any) => s.request)), doc.bindings.parametersSha256)
  assert.equal(digest(doc.scenarios.map((s: any) => s.expected)), doc.bindings.semanticExpectedSha256)
  assert.equal(digest(doc.contract), doc.bindings.contractSha256)
  assert.equal(digest(logicalDatabase(db)), doc.bindings.fixtureSha256)
  assert.deepEqual(logicalDatabase(db).map(t => t[0]), doc.tables)
  // Exact all-row storage round trip with independent raw byte witnesses.
  const raw = db.prepare('select raw_response raw from platform_query where id=11').get() as any
  assert.equal(Buffer.from(raw.raw).toString('hex'), 'e794b2f09f988065cc810d0ae4b999')
  assert.equal(Buffer.byteLength(raw.raw), 15)
  assert.deepEqual(doc.rawWitness, { queryId: 11, field: 'rawResponse', hex: 'e794b2f09f988065cc810d0ae4b999', byteLength: 15 })
  assert.deepEqual(db.prepare('select id, raw_response raw from platform_query where id in (12,13) order by id').all(), [{ id: 12, raw: '' }, { id: 13, raw: null }])
  const relations = db.prepare('select id, query_id queryId, sequence_no sequenceNo, relation_key relationKey, source_text sourceText from platform_relation order by id').all()
  assert.deepEqual(relations, doc.relationWitness)
  for (const transport of ['http', 'mcp']) {
    assert.deepEqual(doc.scenarios.filter((s: any) => s.transport === transport).map((s: any) => s.mode), ['full', 'summary', 'interface', 'title', 'key', 'chunk'])
  }
  for (const s of doc.scenarios) {
    const req = s.request
    const args = s.transport === 'http' ? req.query : req.params.arguments
    const chunk = s.mode === 'chunk'
    if (s.transport === 'http') {
      assert.equal(req.method, 'GET')
      assert.equal(req.path, chunk ? '/api/platform/queries/11/evidence' : '/api/platform/queries')
    } else {
      assert.equal(req.path, '/mcp'); assert.equal(req.jsonrpc, '2.0'); assert.equal(req.id, 621)
      assert.equal(req.method, 'tools/call')
      assert.equal(req.params.name, chunk ? 'get_platform_query_evidence' : 'list_platform_queries')
    }
    const expectedArgs: any = chunk ? { ...(s.transport === 'mcp' ? { queryId: 11 } : {}), field: 'rawResponse', offset: 2, length: 4 }
      : { page: 1, pageSize: s.mode === 'key' ? 1 : 5,
        ...(['summary', 'interface', 'title'].includes(s.mode) ? { view: 'summary' } : {}),
        ...(s.mode === 'interface' ? { interface: 'recognized_list' } : {}),
        ...(s.mode === 'title' ? { titleCode: 'specialized_sme' } : {}),
        ...(s.mode === 'key' ? { queryKey: 'synthetic:甲', includeRawResponse: true } : {}) }
    assert.deepEqual(args, s.transport === 'http' ? Object.fromEntries(Object.entries(expectedArgs).map(([k, v]) => [k, String(v)])) : expectedArgs)
    if (chunk) {
      const e = s.expected
      assert.deepEqual(e, { queryId: 11, field: 'rawResponse', encoding: 'base64', offset: 2, byteLength: 4, totalBytes: 15, isNull: false, hasMore: true, data: 'svCfmA==', decodedHex: 'b2f09f98' })
      assert.equal(Buffer.from(e.data, 'base64').toString('hex'), Buffer.from(raw.raw).subarray(2, 6).toString('hex'))
      continue
    }
    // Independent relational oracle on the tiny explicit dataset; no product SQL/imports.
    const where = s.mode === 'interface' ? "where interface='recognized_list'" : s.mode === 'title' ? "where title_code='specialized_sme'" : s.mode === 'key' ? "where query_key='synthetic:甲'" : ''
    const selected = db.prepare(`select id, query_key queryKey, status from platform_query ${where} order by queried_at desc,id desc`).all() as any[]
    assert.deepEqual(s.expected.rows.map((r: any) => [r.id, r.queryKey, r.status]), selected.map(r => [r.id, r.queryKey, r.status]))
    assert.equal(s.expected.total, selected.length)
    assert.equal(s.expected.page, 1); assert.equal(s.expected.pageSize, Number(args.pageSize))
    const counts: Record<string, number> = {}
    for (const r of selected) counts[r.status] = (counts[r.status] ?? 0) + 1
    assert.deepEqual(s.expected.counts, counts)
    for (const row of s.expected.rows) {
      const ids = (db.prepare('select id from platform_relation where query_id=? order by sequence_no').all(row.id) as any[]).map(r => r.id)
      assert.equal(row.relationCount, ids.length)
      if (args.view === 'summary') {
        assert.equal(row.relationsIncluded, false)
        assert.deepEqual(row.relationIds, [])
        assert.deepEqual(row.omittedQueryFields, ['rawResponse', 'collectionEvidence'])
        assert.ok(!('rawResponse' in row) && !('collectionEvidence' in row))
      } else {
        assert.deepEqual(row.relationIds, ids)
        assert.deepEqual(row.collectionEvidence, row.id === 11 ? { note: '合成😀' } : null)
      }
      if (s.mode === 'key') {
        assert.equal(Buffer.from(row.rawResponse).toString('hex'), 'e794b2f09f988065cc810d0ae4b999')
        assert.equal(row.rawHex, 'e794b2f09f988065cc810d0ae4b999')
      }
    }
  }
}

function workloadInput(doc: any, transport: string, ledger: any[]) {
  return { lane: 'current-read', schemaVersion: 1, receiptId: 'issue-621-manual-literal-v1', workloadId: doc.workloadId,
    artifactManifestSha256: doc.artifactManifestSha256, manifestSha256: sha(bytes),
    seedManifestSha256: digest(doc.seed), generatorBlob: execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString().trim(),
    fixtureSha256: doc.bindings.fixtureSha256, ledgerReceiptSha256: digest(ledger), parametersSha256: digest(doc.scenarios.map((s: any) => s.request)),
    semanticExpectedSha256: digest(doc.scenarios.map((s: any) => s.expected)), transport, timing: 'inline', samples: 20, concurrency: 1,
    scenarios: doc.scenarios.filter((s: any) => s.transport === transport).map((s: any) => ({ id: s.id, mode: s.mode, requestSha256: digest(s.request), expectedSha256: digest(s.expected) })) }
}

it('freezes six modes for each transport before any public request', () => {
  withSeed(document, db => validate(document, db))
})

// Deliberately synthetic comparison carrier. These labelled test-only digests are
// NOT delivered build receipts or artifact evidence. Ordinary unit tests cannot
// authenticate the external artifact, even when this carrier compares equal.
function comparisonFixture() {
  const hash = (label: string) => sha('unit-comparison-fixture:' + label)
  const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8')).entries
    .map((e: any) => ({ tag: e.tag, when: e.when, sqlSha256: sha(readFileSync(join(migrations, e.tag + '.sql'))) }))
  return { lane: 'current-read', schemaVersion: 1, receiptId: 'unit-comparison-only-not-a-build-receipt',
    manifestSha256: document.artifactManifestSha256,
    identity: { sourceSha: hash('source').slice(0, 40), sourceTree: hash('tree').slice(0, 40),
      buildReceiptSha256: hash('receipt'), outputManifestSha256: hash('output'), dependencyManifestSha256: hash('dependencies'),
      serverIndexSha256: hash('server'), journalSha256: sha(readFileSync(join(migrations, 'meta/_journal.json'))),
      files: [{ path: 'server/index.mjs', sha256: hash('server') }, { path: 'unit-only-chunk', sha256: hash('chunk') }], journal },
    runtime: { nodeVersion: 'unit-comparison-only', platform: 'unit-comparison-only', arch: 'unit-comparison-only', nativeSha256: hash('native') } }
}

function checkBindings(artifact: ReturnType<typeof comparisonFixture> | any, exportHandoff = false) {
  withSeed(document, db => {
    const ledger = db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all()
    assert.equal(artifact.identity.journal.length, 44)
    assert.deepEqual(ledger, artifact.identity.journal.map((e: any) => ({ hash: e.sqlSha256, created_at: e.when })))
    expect(digest(ledger)).toBe(document.bindings.ledgerReceiptSha256)
    for (const transport of ['http', 'mcp']) {
      const workload = workloadInput(document, transport, ledger)
      // Reconstructed comparison carrier only, NOT a runtime observation receipt.
      const observation = { lane: 'current-read', schemaVersion: 1, artifact: copy(artifact), workload: copy(workload) }
      expect(compareCurrentReadAuthority(artifact, workload, observation)).toMatchObject({ status: 'COMPARED_UNVALIDATED', qualified: false, runtimeQualified: false })
      if (exportHandoff && process.env.H1B_HANDOFF_DIR) {
        writeFileSync(join(process.env.H1B_HANDOFF_DIR, `workload-${transport}.json`), JSON.stringify(workload, null, 2) + '\n')
      }
    }
    if (exportHandoff && process.env.H1B_HANDOFF_DIR) writeFileSync(join(process.env.H1B_HANDOFF_DIR, 'artifact-envelope.json'), JSON.stringify(artifact, null, 2) + '\n')
  })
}

it('binds 44 tracked canonical migrations and the logical fixture using a comparison-only unit carrier', () => {
  checkBindings(comparisonFixture())
})

// An explicit path opts into full external delivery verification. Missing or bad
// supplied input FAILS; absence skips only this named external acceptance, never
// the ordinary seed/semantic/ledger/mutation tests or their assertions.
it.skipIf(!delivery)('verifies the explicitly supplied independent artifact delivery without qualifying runtime', () => {
  checkBindings(artifactInput(), true)
})

// Reseal altered subdocuments deliberately: rejection must survive internally
// consistent new digests; matching JSON hashes alone are insufficient authority.
const mutations: [string, (d: any) => void][] = [
  ['seed ID', d => { d.seed.platform_query[4].id = 16 }],
  ['expected ID', d => { d.scenarios[0].expected.rows[0].id = 99 }],
  ['UTF-8 seed', d => { d.seed.platform_query[0].raw_response = '甲😀é\r\n乙' }],
  ['UTF-8 expected', d => { d.scenarios[4].expected.rows[0].rawResponse = '甲😀é\r\n乙' }],
  ['relation ownership', d => { d.seed.platform_relation[2].query_id = 13 }],
  ['relation order', d => { d.scenarios[0].expected.rows[0].relationIds.reverse() }],
  ['nonfirst summary leak', d => { d.scenarios[1].expected.rows[1].rawResponse = '' }],
  ['summary relation flag', d => { d.scenarios[1].expected.rows[2].relationsIncluded = true }],
  ['count', d => { d.scenarios[0].expected.counts.failed = 0 }],
  ['mode parameter', d => { d.scenarios[2].request.query.interface = 'apply_list' }],
  ['chunk bytes', d => { d.scenarios[5].expected.data = '' }],
  ['tie order', d => { d.scenarios[0].expected.rows.reverse() }],
  ['total', d => { d.scenarios[0].expected.total = 4 }],
]
it.each(mutations)('rejects independently altered contract %s', (_name, mutate) => {
  const changed = copy(document); mutate(changed)
  changed.bindings.seedSha256 = digest(changed.seed)
  changed.bindings.parametersSha256 = digest(changed.scenarios.map((s: any) => s.request))
  changed.bindings.semanticExpectedSha256 = digest(changed.scenarios.map((s: any) => s.expected))
  withSeed(changed, db => expect(() => validate(changed, db)).toThrow())
})

it.each(['artifact', 'version', 'workload version', 'artifact binding', 'migration middle', 'mode', 'expected digest', 'seed digest'])('rejects stale binding %s through the 620 seam', kind => {
  const artifact = comparisonFixture()
  withSeed(document, db => {
    const workload = workloadInput(document, 'http', db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all())
    const observation = { lane: 'current-read', schemaVersion: 1, artifact: copy(artifact), workload: copy(workload) }
    if (kind === 'artifact') observation.artifact.identity.files[1].sha256 = sha('changed compiled chunk')
    if (kind === 'version') observation.schemaVersion = 2
    if (kind === 'workload version') observation.workload.schemaVersion = 2
    if (kind === 'artifact binding') observation.workload.artifactManifestSha256 = sha('different detached artifact')
    if (kind === 'migration middle') observation.artifact.identity.journal[20].sqlSha256 = sha('changed middle migration')
    if (kind === 'mode') observation.workload.scenarios[0].mode = 'summary'
    if (kind === 'expected digest') observation.workload.semanticExpectedSha256 = sha('changed oracle')
    if (kind === 'seed digest') observation.workload.seedManifestSha256 = sha('changed seed')
    expect(() => compareCurrentReadAuthority(artifact, workload, observation)).toThrow('REJECTED current-read')
  })
})
