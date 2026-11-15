/** Actual migration counterexample for parent adjudication; not target-reader acceptance. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../../../upgrade/legacy-schema'
import { targetSchema } from '../../../upgrade/target-schema'
import { candidateFixture } from '../fixtures/candidate-scope-upgrade'
import { finalizeCandidateScopes } from '../../../upgrade/candidate-scope'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { listPlatformRecognizedDirectory } from '../../../upgrade/frozen/server/platform-recognized-directory'
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options'

it('exposes actual 71609 loss of isolated stored title distinctions while source title remains identical', async () => {
  const f = await candidateFixture(old => {
    old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at)
      VALUES(1,'recognized_list','Q','1,2,3','t','success','c');
      INSERT INTO platform_relation(id,query_id,sequence_no,title_raw,name_raw,uscc_raw,raw_fields,created_at)
      VALUES(1,1,1,'2','Original','U','{"rdjb":"1"}','c'),
            (2,1,2,'3','Original','U','{"rdjb":"1"}','c');`)
    const db = drizzle(old, { schema })
    ensurePlatformObservation(db, 1)
    ensurePlatformObservation(db, 2)
    // Deliberately retain independent legacy stored cells, as permitted by the old schema.
    old.exec("UPDATE platform_relation SET title_raw=CASE id WHEN 1 THEN '2' ELSE '3' END")
  })
  finalizeCandidateScopes(f)
  const legacy = new Database(f.legacySource, { readonly: true })
  const target = new Database(f.target, { readonly: true })
  try {
    const db = drizzle(legacy, { schema })
    const oldRows = listPlatformRecognizedDirectory({ view: 'isolated' }, db)
    const oldOptions = readPlatformFilterOptions({ source: 'recognized-directory', view: 'isolated' }, db)
    expect(oldRows.rows.map(row => row.kind === 'observation' ? row.titleRaw : null)).toEqual(['3', '2'])
    expect(oldOptions.titles).toEqual(['2', '3'])
    expect(listPlatformRecognizedDirectory({ view: 'isolated', titleRaw: '2' }, db).total).toBe(1)
    expect(listPlatformRecognizedDirectory({ view: 'isolated', titleRaw: '3' }, db).total).toBe(1)
    const targetDb = drizzle(target, { schema: targetSchema })
    const p = targetSchema.platformRecognizedProjection
    const facts = targetDb.select({ observationId: p.observationId, titleRaw: p.titleRaw, sourceTitleKind: p.sourceTitleKind, sourceTitleText: p.sourceTitleText }).from(p).orderBy(p.observationId).all()
    expect(target.pragma('user_version', { simple: true })).toBe(71609)
    expect(facts).toEqual([
      { observationId: 1, titleRaw: '1', sourceTitleKind: 'text', sourceTitleText: '1' },
      { observationId: 2, titleRaw: '1', sourceTitleKind: 'text', sourceTitleText: '1' },
    ])
    const catalog = target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    writeFileSync(join(f.root, 'counterexample.json'), JSON.stringify({ phase: 71609, oldRows, oldOptions, facts, catalog }, null, 2))
    // Diagnostic only: passing this test proves the migration counterexample,
    // not preservation. The original failing invariant is retained in r3a/RED-PROBE.
  } finally { target.close(); legacy.close() }
})
