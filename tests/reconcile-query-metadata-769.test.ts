import type { Database } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { chmodSync, copyFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { getComparison } from '../lib/comparison'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { whenIdle } from '../server/utils/job-runner'
import type { RosterImportRequest } from '../lib/roster-import-client'

// Optional original-authority lane. Never replace B1 with a newly seeded database.
const input = process.env.RECONCILE_769_INPUT
const cases = process.env.RECONCILE_769_CASES
const evidence = process.env.RECONCILE_769_EVIDENCE
const authorityTest = input && cases && evidence ? it : it.skip
const uscc = '91330211000000088X'
const queriedAt = '2026-11-13T00:00:00.000Z'
const time = '2026-11-13T04:00:00.000Z'
const key = 'platform_reconcile:31378cd80d723adb2c4cd4f7f6d581d1'
let connection: Database | undefined
let serial = 0

beforeEach(() => {
  vi.stubEnv('MIIT_COOKIE', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(time))
})
afterEach(async () => {
  await whenIdle()
  connection?.close()
  connection = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function open(name: string) {
  if (!input || !cases) throw new Error('Owned B1 input and cases directories required')
  const source = join(input, name + '.sqlite')
  const path = join(cases, `${++serial}-${name}.sqlite`)
  copyFileSync(source, path)
  chmodSync(path, 0o600)
  expect(statSync(path).ino).not.toBe(statSync(source).ino)
  expect(statSync(path).nlink).toBe(1)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const db = drizzle({ connection: { source: path, fileMustExist: true }, schema })
  connection = db.$client
  connection.pragma('foreign_keys=ON')
  return db
}

/** Independent byte/storage-class oracle, including SQL NULL and opaque raw cells. */
function cells(table: string) {
  if (!connection) throw new Error('No owned connection')
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
  const columns = connection.pragma(`table_info(${quote(table)})`) as { name: string }[]
  return connection.prepare(`SELECT ${columns.flatMap(({ name }) => [
    `typeof(${quote(name)}) AS ${quote(name + ':type')}`,
    `hex(cast(${quote(name)} AS blob)) AS ${quote(name + ':hex')}`,
  ]).join(',')} FROM ${quote(table)} ORDER BY id`).all()
}

function sourceCells() {
  return Object.fromEntries(['platform_query', 'platform_relation', 'enterprise_alias'].map(table => [table, cells(table)]))
}

function ledger() {
  return connection!.prepare(`SELECT r.* FROM import_receipt r
    JOIN import_batch b ON b.id=r.batch_id WHERE b.idempotency_key=? ORDER BY r.id`).all(key) as {
      id: number; request_body: string; request_hash: string; status: string; operation: string
    }[]
}

/** Literal B1 expectation: neither the producer nor its payload builder is an oracle. */
function expectedRequest(): RosterImportRequest {
  const rawFields: Record<string, unknown> = JSON.parse('{"id":"SHARED","qymc":"Capture","tyshxydm":"91330211000000088X","rdjb":"2","szsfmc":"P","cszt":"done","whpc":"B","sblx":"申请","sqsj":"D","personuuid":"A","year":2024,"n":1,"b":true,"x":null,"o":{"z":1,"a":false},"arr":[1,false],"__proto__":{"own":true},"constructor":"own"}')
  return {
    idempotencyKey: key, sourceKind: 'alias_evidence',
    sourceIdentity: 'platform/reconcile:specialized_sme', sourceSha256: null,
    payload: {
      platformQueries: [
        { interface: 'business_list', queryKey: uscc, rdjb: '1', titleCode: null, queriedAt, status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
        { interface: 'business_list', queryKey: uscc, rdjb: '2', titleCode: null, queriedAt, status: 'success', failureReason: null, rawResponse: null, relations: [
          { sequenceNo: 1, relationKey: 'SHARED', enterpriseId: 1, usccRaw: uscc, nameRaw: 'Capture', aliasNameRaw: null,
            province: 'P', status: 'done', batch: 'B', declareKind: 'apply', appliedAt: 'D', awardBatchLabel: 'A', year: 2024,
            matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields },
        ] },
        { interface: 'business_list', queryKey: uscc, rdjb: '3', titleCode: null, queriedAt, status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
        { interface: 'apply_list', queryKey: uscc, rdjb: '', titleCode: null, queriedAt, status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
      ],
      differences: [{
        enterpriseName: 'Capture', uscc, titleCode: 'specialized_sme', direction: 'extra_in_miit',
        status: 'needs_review', reasonCode: null,
        reasonNote: '已取得1条原始关系（平台状态：done）；待代理核实原因与措施。',
        measureCode: 'manual_review',
        measureNote: '代理核对正式名单、导出时点、各平台来源及必要的公开证据后，显式提交原因与措施。',
        evidenceQueryRef: { interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt },
        evidenceRelationId: null, movedIn: null, verificationStatus: 'pending', recordedAt: time,
      }],
    },
  }
}

authorityTest.each(['schema0', 'failed-ledger'])('B1 %s preserves original cells and succeeds through the default writer with zero fetch then replays', async name => {
  const db = open(name)
  const fetchImpl = vi.fn(async () => { throw new Error('B1 must never fetch') })
  const options = { db, titles: ['specialized_sme'], usccs: [uscc], cookie: null, fetchImpl, now: () => new Date(time) }
  const before = sourceCells()
  const historicalReceipts = ledger()
  const recordsBefore = cells('platform_business_record')
  const versionsBefore = cells('platform_business_record_version')
  const observationsBefore = cells('platform_business_observation')
  expect(getComparison(db, { title: ['specialized_sme'] }).rows.filter(row => row.uscc === uscc)).toEqual([{
    enterpriseId: 1, name: 'Capture', uscc, district: null, titleCode: 'specialized_sme', direction: 'extra_in_miit',
    curated: false, evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: null, regStatus: null },
  }])
  if (name === 'failed-ledger') {
    expect(historicalReceipts.map(row => [row.operation, row.status])).toEqual([['preflight', 'preflight'], ['commit', 'failed']])
    expect(JSON.parse(historicalReceipts[1]!.request_body).payload.platformQueries.map((q: { titleCode: string | null }) => q.titleCode))
      .toEqual(['innovative_sme', 'specialized_sme', 'little_giant', null])
  } else expect(historicalReceipts).toEqual([])
  let report: Awaited<ReturnType<typeof runPlatformReconcile>> | undefined
  try {
    report = await runPlatformReconcile(options)
    await whenIdle()
    expect(report.queries).toEqual({ network: 0, reused: 4, byInterface: { business_list: 0, apply_list: 0 } })
    expect(report.counts).toEqual({ confirmed: 0, byReason: {}, noRecord: 0, needsReview: 1, queryFailed: 0, notQueried: 0, reusedFresh: 0, total: 1 })
    expect(report.write).toEqual({ batchId: 46, status: 'committed', written: 1, skipped: 1 })
    const receipts = ledger()
    expect(receipts.slice(0, historicalReceipts.length)).toEqual(historicalReceipts)
    expect(receipts.slice(historicalReceipts.length).map(row => [row.operation, row.status]))
      .toEqual([['preflight', 'preflight'], ['commit', 'committed']])
    for (const row of receipts.slice(historicalReceipts.length)) expect(JSON.parse(row.request_body)).toEqual(expectedRequest())
    expect(connection!.prepare('SELECT enterprise_id,title_code,direction,status,evidence_query_id,evidence_relation_id,verification_status FROM difference_reason ORDER BY id').all())
      .toEqual([{ enterprise_id: 1, title_code: 'specialized_sme', direction: 'extra_in_miit', status: 'needs_review', evidence_query_id: 1, evidence_relation_id: null, verification_status: 'pending' }])
    expect(sourceCells()).toEqual(before)
    // Original B1 already has its typed materialization; this reuse adds none.
    expect(cells('platform_business_record')).toEqual(recordsBefore)
    expect(cells('platform_business_record_version')).toEqual(versionsBefore)
    expect(cells('platform_business_observation')).toEqual(observationsBefore)
    const afterFirst = Object.fromEntries(['platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'difference_reason', 'import_batch', 'import_receipt'].map(table => [table, cells(table)]))
    const repeated = await runPlatformReconcile(options)
    expect(repeated.queries.reused).toBe(4)
    expect(repeated.counts.reusedFresh).toBe(1)
    expect(repeated.write).toBeNull()
    // Re-submit the literal corrected command using the SAME existing key.
    expect(preflightRosterImport(db, expectedRequest()).preflight.conflicts).toEqual([])
    expect(commitRosterImport(db, expectedRequest()).status).toBe('committed')
    await whenIdle()
    expect(sourceCells()).toEqual(before)
    for (const [table, expected] of Object.entries(afterFirst)) expect(cells(table), table).toEqual(expected)
    const changed = expectedRequest()
    changed.payload.platformQueries![0]!.titleCode = 'innovative_sme'
    expect(() => preflightRosterImport(db, changed)).toThrow('Idempotency key belongs to a different request')
    expect(ledger()).toEqual(receipts)
    expect(sourceCells()).toEqual(before)
    expect(fetchImpl).not.toHaveBeenCalled()
    if (evidence) writeFileSync(join(evidence, `${name}-success.json`), JSON.stringify({
      report, repeated, before, recordsBefore, recordsAfter: cells('platform_business_record'),
      versionsBefore, versionsAfter: cells('platform_business_record_version'),
      observationsBefore, observationsAfter: cells('platform_business_observation'), receipts: ledger(),
      literalRequest: expectedRequest(), historicalReceiptsPreserved: true, sameKey: key,
    }, null, 2))
  } finally {
    // Preserve the actual failing request/receipts even when the base rejects before returning.
    if (evidence) writeFileSync(join(evidence, `${name}-attempt.json`), JSON.stringify({
      report, fetchCalls: fetchImpl.mock.calls.length, receipts: ledger(),
      before, after: sourceCells(), versionsBefore, versionsAfter: cells('platform_business_record_version'),
    }, null, 2))
  }
})
