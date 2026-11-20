import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createRuntimeSchema } from '../../../db/create-runtime'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { planPostgresRawAnnouncementPreflight } from '../../../layers/sme-roster/server/utils/announcement-preflight-postgres'
import { preflightRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'
import { minimalPdf } from '../../support/minimal-pdf'

const bin = process.env.TEST_ROSTER_ANNOUNCEMENT_PG_BIN
let directory: string | undefined
let started = false
let pool: pg.Pool

beforeAll(async () => {
  if (!bin) return
  directory = mkdtempSync(join(tmpdir(), 'pg-announcement-'))
  const data = join(directory, 'data')
  execFileSync(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe' })
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-o',
    `-h '' -k "${directory}"`, '-w', 'start'], { stdio: 'pipe' })
  started = true
  pool = new pg.Pool({ host: directory, user: 'fixture', database: 'postgres', options: '-c search_path=business,public' })
  await pool.query(`
    CREATE SCHEMA business;
    CREATE TABLE enterprise (id bigint PRIMARY KEY, name text NOT NULL, name_norm text NOT NULL, uscc_norm text UNIQUE,
      district text, city text, reg_status text, quality_flags text DEFAULT '[]');
    CREATE TABLE enterprise_merge (from_enterprise_id bigint PRIMARY KEY, into_enterprise_id bigint NOT NULL);
    CREATE TABLE stored_file (id bigint PRIMARY KEY, rel_path text UNIQUE, display_name text,
      filename text NOT NULL, ext text NOT NULL, bytes bigint NOT NULL, sha256 text NOT NULL,
      created_at text NOT NULL, removed_at text);
    CREATE TABLE enterprise_alias (id bigint PRIMARY KEY, enterprise_id bigint NOT NULL, name text NOT NULL,
      version bigint NOT NULL, verification_status text NOT NULL);
    CREATE TABLE service_credential (key text PRIMARY KEY, value text NOT NULL, updated_at text NOT NULL);
  `)
  for (const file of ['roster-schema', 'roster-platform-schema', 'roster-review-schema']) {
    await pool.query(readFileSync(`db/postgresql/${file}.sql`, 'utf8'))
  }
})

afterAll(async () => {
  await pool?.end()
  if (started) execFileSync(join(bin!, 'pg_ctl'), ['-D', join(directory!, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' })
  if (directory) rmSync(directory, { recursive: true, force: true })
})

type RecordInput = NonNullable<RosterImportRequest['payload']['announcement']>['records'][number]
const usccA = '91330201753252106U'
const usccB = '91330211255994457P'
const item = (name: string, uscc?: string): RecordInput => ({ enterprise: { name, uscc }, titleCode: 'specialized_sme' })
function request(records: RecordInput[]): RosterImportRequest {
  return { sourceKind: 'announcement', sourceIdentity: 'notice.pdf', idempotencyKey: 'raw-preview',
    payload: { announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic announcement' }, records } } }
}

function preview(input: RosterImportRequest) {
  return drizzle(pool).transaction(tx => planPostgresRawAnnouncementPreflight(tx, input, { filesDir: directory }),
    { accessMode: 'read only', isolationLevel: 'repeatable read' })
}

it.runIf(!!bin)('reuses the sole same-batch USCC in either order and leaves intake and business rows untouched', async () => {
  const rows = [item('同批企业'), item('同批企业', usccA)]
  const expected = { add: 1, update: 0, remove: 0, review: 1, conflicts: [], evidenceRepoints: 0, duplicateCandidates: [] }
  expect(await preview(request(rows))).toEqual(expected)
  expect(await preview(request([...rows].reverse()))).toEqual(expected)
  const { rows: [counts] } = await pool.query(`SELECT (SELECT count(*)::int FROM enterprise) AS enterprises,
    (SELECT count(*)::int FROM record) AS records, (SELECT count(*)::int FROM record_event) AS events,
    (SELECT count(*)::int FROM record_evidence) AS evidence, (SELECT count(*)::int FROM roster_announcement_intake) AS intake`)
  expect(counts).toEqual({ enterprises: 0, records: 0, events: 0, evidence: 0, intake: 0 })
})

it.runIf(!!bin)('reports name-only ambiguity and shows the earlier same-name create as a candidate', async () => {
  const rows = [item('同名企业', usccA), item('同名企业'), item('同名企业', usccB)]
  const result = await preview(request(rows))
  expect(result).toMatchObject({ add: 2, update: 0, review: 0, conflicts: [
    { ref: 'record:1', kind: 'record', error: { code: 'enterprise_ambiguous', field: 'enterprise.uscc' } },
  ] })
  expect(result.duplicateCandidates).toEqual([{
    basis: 'same_name_norm', sourceRef: 'record:2', name: '同名企业', nameNorm: '同名企业',
    newEnterpriseId: null, newUscc: usccB, existingEnterpriseId: null, existingEnterpriseName: '同名企业', existingUscc: usccA,
  }])
})

it.runIf(!!bin)('rejects malformed credit codes and out-of-range original PDF pages before resolving the batch', async () => {
  writeFileSync(join(directory!, 'notice.pdf'), minimalPdf({ pages: 1 }))
  const result = await preview(request([
    item('校验企业'),
    item('校验企业', '913302017532521060'),
    { ...item('页码企业'), events: [{ eventType: 'award', evidence: [{ sourceFile: 'notice.pdf', page: 2 }] }] },
  ]))
  expect(result).toMatchObject({ add: 0, review: 0, duplicateCandidates: [], conflicts: [
    { ref: 'record:1', error: { code: 'uscc_format_invalid' } },
    { ref: 'record:2#0/e0', error: { code: 'page_invalid' } },
  ] })
})

it.runIf(!!bin)('previews one equal-content repoint through a merged USCC and preserves the stored evidence', async () => {
  const hash = 'a'.repeat(64)
  await pool.query(`
    INSERT INTO enterprise(id, name, name_norm, uscc_norm)
      VALUES (7, '历史企业', '历史企业', '${usccA}'), (8, '当前企业', '当前企业', NULL);
    INSERT INTO enterprise_merge VALUES (7, 8);
    INSERT INTO record(id, enterprise_id, title_code, source) VALUES (17, 8, 'specialized_sme', 'jxj');
    INSERT INTO record_event(id, record_id, event_type, year) VALUES (29, 17, 'award', 2024);
    INSERT INTO record_evidence(id, record_event_id, source_file, list_no) VALUES (37, 29, 'external.txt', 1);
    INSERT INTO import_batch(idempotency_key, source_kind, source_identity, source_sha256, status, created_at)
      VALUES ('original', 'announcement', 'external.txt', '${hash}', 'committed', '2026-01-01');
  `)
  const row: RecordInput = { ...item('历史企业', usccA), events: [
    { eventType: 'award', year: 2024, evidence: [{ sourceFile: 'library.txt', listNo: 1 }] },
  ] }
  const input = { ...request([row, { ...row, enterprise: { name: '当前企业' } }]), sourceIdentity: 'library.txt', sourceSha256: hash }
  expect(await preview(input)).toMatchObject({
    add: 0, update: 1, evidenceRepoints: 1, review: 1, conflicts: [],
    qualificationDiagnostics: [{ ref: 'record:0#0', eventType: 'award' }, { ref: 'record:1#0', eventType: 'award' }],
    qualificationReadback: { stage: 'before', status: 'captured', target: { enterpriseId: 8 },
      assessment: { enterpriseId: 8, assessmentVersion: 'enterprise-qualification-407-v1' } },
  })
  expect((await pool.query('SELECT source_file FROM record_evidence WHERE id=37')).rows).toEqual([{ source_file: 'external.txt' }])
  expect(await preview({ ...input, sourceSha256: 'b'.repeat(64) })).toMatchObject({
    add: 0, update: 0, evidenceRepoints: 0,
    conflicts: [{ ref: 'record:0', error: { code: 'evidence_content_hash_mismatch' } },
      { ref: 'record:1', error: { code: 'evidence_content_hash_mismatch' } }],
  })
})

it.runIf(!!bin)('preserves the raw typed-capture plan hash without publishing an official row', async () => {
  const path = 'capture.txt'
  writeFileSync(join(directory!, path), 'original published line')
  const publishedRow: OfficialPublishedRow = {
    nameRaw: ' 公布原名 ', usccRaw: null, districtRaw: null,
    declaration: { kind: 'independent', basis: 'verified source', sourceDocument: {
      source: 'jxj', title: 'Synthetic announcement', path, docNumber: null, issueDate: null,
    } },
    storedFileId: null, path, sha256: null, bytes: null, attachment: null, sectionKey: null, listNo: 1,
    page: null, sourceBindingKnown: false, actor: { type: 'agent', id: 'fixture' }, basis: 'verified wording',
  }
  const input = request([{ ...item('待核主体'), events: [
    { eventType: 'award', year: 2024, evidence: [{ sourceFile: path, listNo: 1, publishedRow }] },
  ] }])
  const sqlite = new Database(':memory:')
  try {
    createRuntimeSchema(sqlite)
    const { preflight: legacy } = preflightRosterImport(drizzleSqlite(sqlite, { schema }), input, [], { filesDir: directory })
    expect(legacy.officialEvidencePlanHash).toMatch(/^[a-f\d]{64}$/)
    expect(await preview(input)).toMatchObject({
      add: 1, update: 1, review: 1, conflicts: [],
      qualificationReadback: { stage: 'before', status: 'not_retained', reason: 'new_target', target: null },
      officialEvidencePlanHash: legacy.officialEvidencePlanHash,
    })
  } finally {
    sqlite.close()
  }
  expect((await pool.query('SELECT count(*)::int AS count FROM official_evidence_row_revision')).rows).toEqual([{ count: 0 }])
})
