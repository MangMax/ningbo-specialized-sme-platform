/** Actual migration counterexample, not acceptance of a target qualification reader. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { resolveLegacyReference } from '../lib/platform/target-archive'
import { candidateFixture } from './helpers/candidate-scope-target'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { createRecognizedFilterSourceReader } from '../lib/roster/recognized-filter-source'
import { recognizedFilterFacts } from '../lib/roster/recognized-filter-facts'
import { sourcePositionForSequence } from '../lib/platform/recognized-evidence'

it('exposes migrated fullRange numeric gate loss against independent old typed witness and literal facts', async () => {
  const f = await candidateFixture(old => {
    const db = drizzle(old, { schema })
    db.insert(schema.enterprise).values({ id: 1, name: 'Synthetic', nameNorm: 'Synthetic' }).run()
    for (const id of [1, 2]) {
      const evidence = { source: 'queryBusList', status: 'success', completeness: 'complete', fullRange: id,
        effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['1'] },
        pages: [{ source: 'queryBusList', status: 'success', rdjb: '1', page: 1, fetchedCount: 1 }], unfinished: [] }
      db.insert(schema.platformQuery).values({ id, interface: 'recognized_list', queryKey: `Q${id}`, rdjb: '1', titleCode: 'innovative_sme', queriedAt: '2026-11-12T00:00:00Z', status: 'success' }).run()
      // Freeze a legacy SQLite cell; modern writer validation must not admit this shape.
      old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(JSON.stringify(evidence), id)
      db.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: 'shared', enterpriseId: 1, verificationStatus: 'confirmed', rawFields: { id: 'shared', rdjb: '1', rddqrq: '2028-12-31', whpc: '2026-2' } }).run()
      ensurePlatformObservation(db, id)
    }
  })
  finalizeCandidateScopes(f)
  const predecessor = join(f.root, '71609.sqlite')
  copyFileSync(f.target, predecessor)
  finalizeRecognizedStored({ source: predecessor, target: f.target, runId: 'recognized', predecessorRunId: 'candidate' })
  const old = new Database(f.legacySource, { readonly: true })
  const trace: string[] = []
  const target = new Database(f.target, { readonly: true, verbose: statement => trace.push(String(statement)) })
  old.function('roster84_uscc', (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : null)
  try {
    const reader = createRecognizedFilterSourceReader(old, 'typed')
    const accepted = reader.read({ relationId: 1, enterpriseId: 1, uscc: null })
    const rejected = reader.read({ relationId: 2, enterpriseId: 1, uscc: null })
    expect(accepted).toMatchObject({ rawValid: '2028-12-31', rawMaintenanceYear: null, rawMaintenanceBatch: '2026-2' })
    expect(rejected).toBeUndefined()
    if (!accepted) throw new Error('Expected independently accepted old witness')
    expect(sourcePositionForSequence({ pages: JSON.parse(accepted.pages!) }, accepted.sequenceNo)).toEqual({ sourceRdjb: '1', sourcePage: 1 })
    const facts = recognizedFilterFacts({ titleCode: 'innovative_sme', schema: 'queryBusList' },
      { rddqrq: accepted.rawValid, whpcyear: accepted.rawMaintenanceYear, whpc: accepted.rawMaintenanceBatch },
      { rddqrq: accepted.conditionValidYear, whpcyear: accepted.conditionMaintenanceYear, whpc: accepted.conditionMaintenanceBatch })
    expect(facts).toEqual({ validYear: 2028, maintenance: { year: 2026, batch: null } })
    const db = drizzle(target, { schema: targetSchema })
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: 1, relationId: 1 })).toEqual({ version: 2, kind: 'observation', collectionId: 1, observationId: 1 })
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: 2, relationId: 1 })).toBeNull()
    const c = schema.platformCollection
    const gates = db.select({ source: c.source, evidenceStatus: c.evidenceStatus, completeness: c.completeness, fullRange: c.fullRange, parseState: c.parseState, provenanceState: c.provenanceState }).from(c).orderBy(c.id).all()
    writeFileSync(join(f.root, 'r5-counterexample.json'), JSON.stringify({ phase: target.pragma('user_version', { simple: true }), accepted, rejected: rejected ?? null, facts, gates }, null, 2))
    // The retained RED-PROBE expected [1,0] and failed with [null,null].
    // These assertions prove loss, not preservation or target-reader acceptance.
    expect(gates.map(row => row.fullRange)).toEqual([null, null])
    expect(gates[0]).toEqual(gates[1])
    expect(target.pragma('user_version', { simple: true })).toBe(71609)
    const p = targetSchema.platformRecognizedProjection
    const projections = db.select({ versionId: p.versionId, validity: p.sourceValidityDate, maintenance: p.sourceMaintenanceBatch, absent: p.sourceMaintenanceYearAbsent }).from(p).where(eq(p.observationId, 1)).all()
    expect(projections).toHaveLength(1)
    expect(projections[0]).toMatchObject({ validity: '2028-12-31', maintenance: '2026-2', absent: true })
    const p2 = db.select({ versionId: p.versionId, validity: p.sourceValidityDate, maintenance: p.sourceMaintenanceBatch, absent: p.sourceMaintenanceYearAbsent }).from(p).where(eq(p.observationId, 2)).all()
    expect(p2).toEqual(projections)
    const pages = [1, 2].map(collectionId => db.select({ ordinal: schema.platformCollectionPage.ordinal, rdjb: schema.platformCollectionPage.rdjb, fetchedCount: schema.platformCollectionPage.fetchedCount, status: schema.platformCollectionPage.status }).from(schema.platformCollectionPage).where(eq(schema.platformCollectionPage.collectionId, collectionId)).all())
    expect(pages[0]).toEqual(pages[1])
    const conditions = [1, 2].map(collectionId => db.select({ name: schema.platformCollectionCondition.name, kind: schema.platformCollectionCondition.valueKind, text: schema.platformCollectionCondition.textValue, integer: schema.platformCollectionCondition.integerValue }).from(schema.platformCollectionCondition).where(eq(schema.platformCollectionCondition.collectionId, collectionId)).all())
    expect(conditions[0]).toEqual(conditions[1])
    const alias = targetSchema.platformLegacyRelationAlias
    const lookup = db.select().from(alias).where(eq(alias.oldId, 1)).toSQL()
    const plan = target.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).all(...lookup.params)
    expect(trace.join('\n')).not.toMatch(/(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s|json_extract|json_each/i)
    writeFileSync(join(f.root, 'structured-inputs.json'), JSON.stringify({ gates, pages, conditions, projections, p2, plan, trace }, null, 2))
  } finally { target.close(); old.close() }
})
