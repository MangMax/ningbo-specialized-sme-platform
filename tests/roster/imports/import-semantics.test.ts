import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,describe,expect,it} from 'vitest'
import {initializeDb} from '../../../db/client'
import * as schema from '../../../db/schema'
import {preflightRosterImport,commitRosterImport,planRosterImport} from '../../../layers/sme-roster/server/utils/roster-import'
import type {RosterImportRequest} from '../../../layers/sme-roster/lib/roster-import-client'
import {createSemanticRecorder} from './assertions/import-semantics'
import {businessSource} from './fixtures/native-import'
import {listPlatformQueries} from '../../../layers/sme-roster/lib/platform/read'
const dirs:string[]=[]
function makeDb(){const dir=mkdtempSync(join(tmpdir(),'native-import-semantics-'));dirs.push(dir);return initializeDb({create:true,dbPath:join(dir,'native.sqlite')})}
afterAll(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true})})
describe("readonly source count contract", () => {
  // Literal API expectations; batch/receipt bookkeeping and canonicalProjection
  // have separate ledgers. These fixtures never enter the original golden sequence.
  const zero = { add: 0, update: 0, remove: 0, review: 0, conflicts: [], evidenceRepoints: 0 }
  // Keep unrelated candidate jobs staged; no async consumer outlives this fixture.
  const commit = (db: ReturnType<typeof makeDb>, input: RosterImportRequest) =>
    commitRosterImport(db, input, [], { deferCandidateTasks: true })
  const state = (db: ReturnType<typeof makeDb>) => Object.fromEntries([
    'enterprise', 'record', 'record_event', 'record_evidence', 'enterprise_alias',
    'source_document', 'platform_collection', 'platform_observation_assignment', 'platform_legacy_query_alias', 'platform_legacy_relation_alias', 'platform_archive_value', 'difference_reason',
    'platform_export_batch', 'platform_export_row', 'platform_business_record',
    'platform_business_record_version', 'platform_business_observation',
  ].map(table => [table, db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

  it.each(['complete', 'explicit', 'legacy'] as const)('query %s reuse counts zero and preserves sources, receipt and immutable conflicts', (mode) => {
    const db = makeDb()
    try {
      const query: NonNullable<RosterImportRequest['payload']['platformQueries']>[number] = {
        interface: 'business_list', queryKey: 'name:count-zero-synthetic', rdjb: '2',
        titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z',
        status: 'success', rawResponse: '{"original":true}',
        relations: [{ sequenceNo: 1, relationKey: 'count-zero-row', nameRaw: '合成', rawFields: { id: 'count-zero-row', qymc: '合成', n: 1 } }],
      }
      const input: RosterImportRequest = { idempotencyKey: 'count-zero/query/new', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/count-zero', payload: { platformQueries: [query] } }
      expect(preflightRosterImport(db, input).preflight).toMatchObject({ ...zero, add: 1, batchStatus: 'preflight', duplicateCandidates: [] })
      const original = commit(db, input)
      expect(original).toMatchObject({ status: 'committed', summary: { written: 2, skipped: 0, failed: 0 }, items: [{ detail: { rowsWritten: 2 } }] })
      const before = state(db)
      const reusedQuery = mode === 'complete' ? query : {
        ...query, rawResponse: null,
        relations: [{ sequenceNo: 1, relationKey: 'count-zero-row', nameRaw: '合成' }],
        ...(mode === 'explicit' ? { reuseExisting: true as const } : {}),
      }
      const replay = { ...input, idempotencyKey: 'count-zero/query/reuse', payload: { platformQueries: [reusedQuery] } }
      expect(preflightRosterImport(db, replay).preflight).toMatchObject({ ...zero, batchStatus: 'preflight', duplicateCandidates: [] })
      expect(state(db)).toEqual(before)
      const result = commit(db, replay)
      expect(result).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1, failed: 0, evidenceRepointed: 0 }, items: [{ detail: { rowsWritten: 0, relations: [], skipped: 1, reuseExisting: true } }] })
      expect(state(db)).toEqual(before)
      expect(preflightRosterImport(db, replay).preflight).toEqual({ ...zero, batchStatus: 'committed' })
      expect(commit(db, replay)).toEqual(result)
      expect(commit(db, input)).toEqual(original)
      // A new key never authorizes changing immutable metadata or relation sets.
      const queryConflicts: [string, typeof query, string][] = [
        ['raw', { ...query, rawResponse: 'changed' }, 'query_payload_conflict'],
        ['rows', { ...query, relations: [] }, 'query_relation_set_conflict'],
      ]
      for (const [id, changed, code] of queryConflicts) {
        const conflict = { ...input, idempotencyKey: `count-zero/query/conflict-${id}`, payload: { platformQueries: [changed] } }
        expect(preflightRosterImport(db, conflict).preflight.conflicts.map(item => item.error?.code)).toEqual([code])
        const rejected = commit(db, conflict)
        expect(rejected.status).toBe('failed')
        expect(rejected.summary).toEqual({ written: 0, skipped: 0, failed: 1, evidenceRepointed: 0 })
        expect(rejected.items.map(item => item.error?.code)).toEqual([code])
        expect(state(db)).toEqual(before)
      }
    } finally { db.$client.close() }
  })

  it('snapshot reuse counts zero and preserves sources, receipt and immutable conflicts', () => {
    const db = makeDb()
    try {
      const input: RosterImportRequest = {
        idempotencyKey: 'count-zero/snapshot/new', sourceKind: 'platform_export', sourceIdentity: 'synthetic/count-zero.xlsx',
        payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-26', originalFilename: 'synthetic.xlsx', sha256: 'count-zero-synthetic-sha', rows: [{ sourceRowNo: 3, nameRaw: '合成', rawFields: { original: '  合成🙂\n', unknown: null } }] } },
      }
      expect(preflightRosterImport(db, input).preflight).toEqual({ ...zero, add: 1, duplicateCandidates: [], batchStatus: 'preflight' })
      const original = commit(db, input)
      expect(original).toMatchObject({ status: 'committed', summary: { written: 2, failed: 0 }, items: [{ detail: { rowsWritten: 2 } }] })
      const before = state(db)
      const replay = { ...input, idempotencyKey: 'count-zero/snapshot/reuse' }
      expect(preflightRosterImport(db, replay).preflight).toEqual({ ...zero, duplicateCandidates: [], batchStatus: 'preflight' })
      expect(state(db)).toEqual(before)
      const result = commit(db, replay)
      expect(result).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1, failed: 0, evidenceRepointed: 0 }, items: [{ detail: { rows: [], skipped: 1, rowsWritten: 0 } }] })
      expect(preflightRosterImport(db, replay).preflight).toEqual({ ...zero, batchStatus: 'committed' })
      expect(commit(db, replay)).toEqual(result)
      expect(commit(db, input)).toEqual(original)
      const snapshot = input.payload.exportSnapshot!
      for (const [id, rows, code] of [
        ['raw', [{ ...snapshot.rows[0]!, rawFields: { original: 'changed' } }], 'export_row_payload_conflict'],
        ['rows', [], 'export_row_set_conflict'],
      ] as const) {
        const conflict = { ...input, idempotencyKey: `count-zero/snapshot/conflict-${id}`, payload: { exportSnapshot: { ...snapshot, rows: [...rows] } } }
        expect(preflightRosterImport(db, conflict).preflight.conflicts.map(item => item.error?.code)).toEqual([code])
        const rejected = commit(db, conflict)
        expect(rejected.status).toBe('failed')
        expect(rejected.summary).toEqual({ written: 0, skipped: 0, failed: 1, evidenceRepointed: 0 })
        expect(rejected.items.map(item => item.error?.code)).toEqual([code])
        expect(state(db)).toEqual(before)
      }
      expect(state(db)).toEqual(before)
    } finally { db.$client.close() }
  })
})
it('records actual native source ownership and same-key receipts without a storage golden rewrite',()=>{
 const db=makeDb(),recorder=createSemanticRecorder(db),query=businessSource('native-recorded',[{sequenceNo:1,relationKey:'A',rawFields:{id:'A',unknown:null,value:'原字节🙂'}},{sequenceNo:2,relationKey:'A',rawFields:{id:'A',unknown:false,value:0}}])
 const request:RosterImportRequest={idempotencyKey:'native-semantic-receipt',sourceKind:'platform_archive',sourceIdentity:'native-original',payload:{platformQueries:[query]}}
 const before=db.select().from(schema.platformCollection).all();recorder.capture('preflight',preflightRosterImport(db,request));expect(db.select().from(schema.platformCollection).all()).toEqual(before)
 const committed=commitRosterImport(db,request,[],{deferCandidateTasks:true});expect(committed.status,JSON.stringify(committed)).toBe('committed');recorder.capture('committed',committed)
 expect(recorder.steps[1]!.rowCounts).toMatchObject({platformCollection:1,platformBusinessObservation:2,platformObservationAssignment:2,platformLegacyQueryAlias:1,platformLegacyRelationAlias:2,importReceipt:2})
 expect(listPlatformQueries(db).rows[0]!.relations.map(row=>row.rawFields)).toEqual(query.relations!.map(row=>row.rawFields))
 expect(commitRosterImport(db,request,[],{deferCandidateTasks:true})).toEqual(committed);recorder.capture('replay',committed)
 expect(recorder.steps[2]!.changed).toEqual({});db.$client.close()
})
it.each([{sequenceNo:0},{sequenceNo:-1},{sequenceNo:1.9},{sequenceNo:Number.MAX_SAFE_INTEGER+1},{sequenceNo:2},{sequenceNo:1,year:2026.9}])('rejects invalid native coordinates during preflight before creating source rows: %j',row=>{
 const db=makeDb(),query=businessSource('invalid-native',[{rawFields:{id:'A',unknown:null},...row}]),request:RosterImportRequest={idempotencyKey:'invalid-coordinates',sourceKind:'platform_archive',sourceIdentity:'native-invalid',payload:{platformQueries:[query]}}
 const before=db.$client.serialize(),expected='year'in row?'year_invalid':'sequence_no_invalid'
 expect(planRosterImport(db,request).conflicts.map(item=>item.error?.code)).toContain(expected);expect(db.$client.serialize().equals(before)).toBe(true)
 expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('failed')
 expect(db.select().from(schema.platformCollection).all()).toEqual([]);expect(db.select().from(schema.platformArchiveValue).all()).toEqual([]);db.$client.close()
})
