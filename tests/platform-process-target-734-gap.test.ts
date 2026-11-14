/** #734 parent-adjudication probe. Not target-reader acceptance. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { candidateFixture } from './helpers/candidate-scope-target'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { listPlatformBusinessProcesses } from '../upgrade/frozen/server/platform-business-processes'
import { readPlatformFilterOptions } from '../upgrade/frozen/server/platform-filter-options'

it('exposes complete-migration loss of isolated process stored cells independently of normalized source facts', async () => {
  const f = await candidateFixture(source => {
    source.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at)
      VALUES(1,'business_list','Q','2,3','t','success','c');
      INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,uscc_raw,raw_fields,created_at)
      VALUES(1,1,1,' Original ',' U ','{"rdjb":"1","sblx":"申请","year":2024,"cszt":"pending","whpc":"B","personuuid":"Award","szsfmc":"P","sqsj":"D"}','c'),
            (2,1,2,' Original ',' U ','{"rdjb":"1","sblx":"申请","year":2024,"cszt":"pending","whpc":"B","personuuid":"Award","szsfmc":"P","sqsj":"D"}','c');`)
    const db = drizzle(source, { schema })
    ensurePlatformObservation(db, 1)
    ensurePlatformObservation(db, 2)
    // Legal independent old SQLite cells, not a projection-derived expected value.
    source.exec(`UPDATE platform_relation SET title_raw=CASE id WHEN 1 THEN '2' ELSE '3' END,
      declare_kind=CASE id WHEN 1 THEN '申请' ELSE 'apply' END, year=2024,
      status=CASE id WHEN 1 THEN ' pending ' ELSE 'pending' END,
      batch=CASE id WHEN 1 THEN ' B ' ELSE 'B' END,
      applied_at=CASE id WHEN 1 THEN ' D ' ELSE 'D' END,
      award_batch_label=CASE id WHEN 1 THEN ' Award ' ELSE 'Award' END,
      province=CASE id WHEN 1 THEN ' P ' ELSE 'P' END;`)
  })
  finalizeCandidateScopes(f)
  const snapshot = join(f.root, '71609.sqlite')
  copyFileSync(f.target, snapshot)
  finalizeRecognizedStored({ source: snapshot, target: f.target, runId: 'recognized', predecessorRunId: 'candidate' })
  const legacy = new Database(f.legacySource, { readonly: true })
  const trace: string[] = []
  const target = new Database(f.target, { readonly: true, verbose: q => trace.push(String(q)) })
  try {
    const db = drizzle(legacy, { schema })
    const rows = listPlatformBusinessProcesses({ view: 'isolated' }, db)
    const options = readPlatformFilterOptions({ source: 'business-processes', view: 'isolated' }, db)
    const selected = rows.rows.map(r => {
      if (r.kind !== 'observation') throw new Error('Expected isolated observation')
      return { title: r.titleRaw, kind: r.declareKind, year: r.businessYear, status: r.status, batch: r.batch, date: r.appliedAt, award: r.awardBatchLabel, province: r.province }
    })
    expect(selected).toEqual([
      { title: '3', kind: 'apply', year: 2024, status: 'pending', batch: 'B', date: 'D', award: 'Award', province: 'P' },
      { title: '2', kind: '申请', year: 2024, status: ' pending ', batch: ' B ', date: ' D ', award: ' Award ', province: ' P ' },
    ])
    expect(options).toEqual({ titles: ['2', '3'], declareKinds: ['apply', '申请'], years: [2024], statuses: [' pending ', 'pending'], batches: [' B ', 'B'], districts: [], validityDates: [] })
    const filters = [{ titleRaw: '2' }, { titleRaw: '3' }, { status: 'pending' }, { batch: 'B' }, { declareKind: '申请' }]
    expect(filters.map(filter => listPlatformBusinessProcesses({ view: 'isolated', ...filter }, db).total)).toEqual([1, 1, 1, 1, 1])
    const p = targetSchema.platformBusinessProjection
    const query = drizzle(target, { schema: targetSchema }).select({ observationId: p.observationId, title: p.titleRaw, kind: p.storedDeclareKind, year: p.storedYear, status: p.storedStatus, batch: p.storedBatch, date: p.storedAppliedAt, award: p.storedAwardBatchLabel, province: p.storedProvince }).from(p).orderBy(p.observationId)
    const facts = query.all()
    const compiled = query.toSQL()
    const plan = target.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`).all()
    const catalog = target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    expect(target.pragma('user_version', { simple: true })).toBe(71609)
    writeFileSync(join(f.root, 'counterexample.json'), JSON.stringify({ selected, options, facts, catalog, trace, filters, plan, query: compiled }, null, 2))
    // This PASS diagnoses the loss; the preservation invariant remains FAIL in red-cells.log.
    expect(facts).toEqual([
      { observationId: 1, title: '1', kind: 'apply', year: 2024, status: 'pending', batch: 'B', date: 'D', award: 'Award', province: 'P' },
      { observationId: 2, title: '1', kind: 'apply', year: 2024, status: 'pending', batch: 'B', date: 'D', award: 'Award', province: 'P' },
    ])
    expect(facts.map(({ observationId, ...values }) => values).reverse()).not.toEqual(selected)
    expect(target.pragma('foreign_key_check')).toEqual([])
    expect(target.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { target.close(); legacy.close() }
})
