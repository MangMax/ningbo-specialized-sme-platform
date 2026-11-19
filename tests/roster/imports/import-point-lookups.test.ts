import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { schema } from '../../../db'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { commitRosterImport, preflightRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'

const dirs: string[] = []
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-point-lookups-'))
  dirs.push(dir)
  return initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function request(key: string): RosterImportRequest {
  return {
    idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: "jxj/历史'O公告.xlsx",
    sourceSha256: 'a'.repeat(64),
    payload: { announcement: {
      sourceDocument: { source: 'jxj', title: "历史'O公告", docNumber: "甬〔2026〕'号" },
      records: Array.from({ length: 8 }, (_, i) => ({
        enterprise: { name: `合成点查'O企业${i}` },
        titleCode: 'little_giant',
        events: [{ eventType: 'award', year: 2020, batchSeq: 1,
          evidence: [{ sourceFile: "jxj/历史'O公告.xlsx", attachment: "附件'一", listNo: i + 1 }] }],
      })),
    } },
  }
}

type QueryRead = { sql: string; calls: number; rows: number; ms: number; plan: unknown[] }
/** Observe the real native statements; no query/results are substituted. Setup is outside the window. */
function measure<T>(db: ReturnType<typeof makeDb>, run: () => T) {
  const reads = new Map<string, QueryRead>()
  const prepare = db.$client.prepare.bind(db.$client)
  const restores: Array<() => void> = []
  const observer = vi.spyOn(db.$client, 'prepare').mockImplementation((query: string) => {
    const statement = prepare(query)
    if (!/^select\b/i.test(query)) return statement
    const all = statement.all.bind(statement)
    const get = statement.get.bind(statement)
    const observe = (params: unknown[], result: unknown, elapsed: number, rows: number) => {
      let read = reads.get(query)
      if (!read) {
        read = { sql: query, calls: 0, rows: 0, ms: 0, plan: prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) }
        reads.set(query, read)
      }
      read.calls++; read.rows += rows; read.ms += elapsed
      return result
    }
    const allSpy = vi.spyOn(statement, 'all').mockImplementation((...params: unknown[]) => {
      const start = performance.now(); const rows = all(...params)
      observe(params, rows, performance.now() - start, rows.length)
      return rows
    })
    const getSpy = vi.spyOn(statement, 'get').mockImplementation((...params: unknown[]) => {
      const start = performance.now(); const row = get(...params)
      return observe(params, row, performance.now() - start, row === undefined ? 0 : 1)
    })
    restores.push(() => { allSpy.mockRestore(); getSpy.mockRestore() })
    return statement
  })
  const start = performance.now()
  try {
    const result = run()
    return { result, ms: performance.now() - start, reads: [...reads.values()] }
  } finally { observer.mockRestore(); for (const restore of restores) restore() }
}

function seedUnrelated(db: ReturnType<typeof makeDb>, size: number) {
  db.transaction(tx => {
    for (let i = 0; i < size; i++) {
      const enterpriseId = tx.insert(schema.enterprise).values({ name: `无关企业${i}`, nameNorm: `无关企业${i}` })
        .returning({ id: schema.enterprise.id }).get().id
      const recordId = tx.insert(schema.record).values({ enterpriseId, titleCode: 'little_giant', source: 'miit' })
        .returning({ id: schema.record.id }).get().id
      tx.insert(schema.recordEvent).values({ recordId, eventType: 'maintain', year: 2025 }).run()
    }
  })
}

function rowsFrom(reads: QueryRead[], table: string) {
  return reads.filter(read => new RegExp(`from "${table}"(?: |$)`).test(read.sql)).reduce((sum, read) => sum + read.rows, 0)
}

describe('Historical import point lookup work', () => {
  it('unrelated records and events do not multiply per-row materialization in preflight and commit', () => {
    const samples = [0, 1000].map(size => {
      const db = makeDb()
      const initial = commitRosterImport(db, request('initial'))
      expect(initial.status, JSON.stringify(initial)).toBe('committed')
      seedUnrelated(db, size)
      const input = request('measured')
      const preflight = measure(db, () => preflightRosterImport(db, input))
      const commit = measure(db, () => commitRosterImport(db, input))
      // Stable write-plan contract; qualification diagnostics/readback are
      // covered by their own tests and are not part of the point-lookup budget.
      expect(preflight.result.preflight).toMatchObject({ add: 0, update: 0, remove: 0, review: 8, conflicts: [], duplicateCandidates: [], evidenceRepoints: 0, batchStatus: 'preflight' })
      expect(commit.result.status).toBe('committed')
      expect(commit.result.summary).toEqual({ written: 0, skipped: 16, failed: 0, evidenceRepointed: 0 })
      expect(commitRosterImport(db, input)).toEqual(commit.result)
      return { size, preflight, commit }
    })

    expect(samples[1]!.commit.result).toEqual(samples[0]!.commit.result)
    for (const phase of ['preflight', 'commit'] as const) {
      // A single batch-wide ambiguity pass is allowed; per-input full-table work is not.
      expect(rowsFrom(samples[1]![phase].reads, 'record') - rowsFrom(samples[0]![phase].reads, 'record')).toBeLessThanOrEqual(1000 + 64)
      expect(rowsFrom(samples[1]![phase].reads, 'record_event') - rowsFrom(samples[0]![phase].reads, 'record_event')).toBeLessThanOrEqual(64)
    }
  })
})

describe('Historical import lookup equivalence', () => {
  it('keeps null and omitted coordinates together but zero and each event dimension distinct', () => {
    const db = makeDb()
    const input = request('coordinates')
    const announcement = input.payload.announcement!
    const row = announcement.records[0]!
    announcement.records = [row]
    row.events = [
      { eventType: 'review' },
      { eventType: 'review', year: null, batchSeq: null, reviewOutcome: null, decidedYear: null },
      { eventType: 'review', year: 0 },
      { eventType: 'review', batchSeq: 0 },
      { eventType: 'review', decidedYear: 0 },
      { eventType: 'review', reviewOutcome: 'passed' },
      { eventType: 'review', reviewOutcome: 'failed' },
      { eventType: 'award' },
    ]
    const first = commitRosterImport(db, input)
    expect(first.status).toBe('committed')
    expect(first.summary).toEqual({ written: 10, skipped: 1, failed: 0, evidenceRepointed: 0 })
    const enterprise = db.select().from(schema.enterprise).get()!
    const record = db.select().from(schema.record).get()!
    const project = () => db.select({ eventType: schema.recordEvent.eventType, year: schema.recordEvent.year,
      batchSeq: schema.recordEvent.batchSeq, reviewOutcome: schema.recordEvent.reviewOutcome,
      decidedYear: schema.recordEvent.decidedYear }).from(schema.recordEvent).orderBy(schema.recordEvent.id).all()
    expect(project()).toEqual([
      { eventType: 'review', year: null, batchSeq: null, reviewOutcome: null, decidedYear: null },
      { eventType: 'review', year: 0, batchSeq: null, reviewOutcome: null, decidedYear: null },
      { eventType: 'review', year: null, batchSeq: 0, reviewOutcome: null, decidedYear: null },
      { eventType: 'review', year: null, batchSeq: null, reviewOutcome: null, decidedYear: 0 },
      { eventType: 'review', year: null, batchSeq: null, reviewOutcome: 'passed', decidedYear: null },
      { eventType: 'review', year: null, batchSeq: null, reviewOutcome: 'failed', decidedYear: null },
      { eventType: 'award', year: null, batchSeq: null, reviewOutcome: null, decidedYear: null },
    ])
    // Existing databases may have duplicate coordinates. Preserve them, reuse them, and add no evidence.
    db.insert(schema.recordEvent).values({ id: 100, recordId: record.id, eventType: 'review' }).run()
    db.insert(schema.recordEvent).values({ id: 50, recordId: record.id, eventType: 'review' }).run()
    const before = project()
    const replay = commitRosterImport(db, { ...input, idempotencyKey: 'coordinate-reuse' })
    expect(replay.summary).toEqual({ written: 0, skipped: 9, failed: 0, evidenceRepointed: 0 })
    expect(project()).toEqual(before)
    expect(commitRosterImport(db, input)).toEqual(first)

    // The same enterprise and coordinates in another title/source/record are independent.
    for (const [titleCode, source] of [['specialized_sme', 'jxj'], ['little_giant', 'miit']] as const) {
      const isolated = structuredClone(input)
      isolated.idempotencyKey = `${titleCode}/${source}`
      isolated.payload.announcement!.records[0]!.titleCode = titleCode
      isolated.payload.announcement!.records[0]!.source = source
      const result = commitRosterImport(db, isolated)
      expect(result.status).toBe('committed')
      expect(result.items[0]!.detail).toMatchObject({ enterpriseId: enterprise.id, skipped: 1 })
      expect((result.items[0]!.detail!.events as number[])).toHaveLength(7)
    }
    expect(db.select().from(schema.record).all()).toHaveLength(3)
  })
})
