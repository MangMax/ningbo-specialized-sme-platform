import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upgradeCollections } from '../../upgrade/collections';
import { upgradeObservations } from '../../upgrade/observations';
import { upgradeProjections } from '../../upgrade/projections';
import { finalizeObservations, finalizeCollectionScopes } from '../../upgrade/finalize-observations';
import { finalizeFingerprintBasis } from '../../upgrade/fingerprint-basis';
import { finalizeApplyStored } from '../../upgrade/apply-stored';
function fixture(seed?: (db: ReturnType<typeof drizzle<typeof legacySchema>>) => void) {
    const root = mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR ?? tmpdir(), 'apply-stored-'));
    const legacy = join(root, 'legacy.sqlite'), target = join(root, 'target.sqlite'), source = join(root, '71607.sqlite');
    const s = new Database(legacy);
    migrate(drizzle(s), { migrationsFolder: 'db/migrations' });
    s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
 INSERT INTO platform_relation(id,query_id,sequence_no,status,raw_fields,created_at) VALUES(1,1,1,' pending ','{"rdjb":"2","rdjb":"3","cszt":"pending"}','c'),(2,1,2,'pending','{"rdjb":"1","rdjb":"3","cszt":"pending"}','c');
 UPDATE platform_relation SET title_raw='X';`);
    const legacyDb = drizzle(s, { schema: legacySchema });
    if (seed)
        seed(legacyDb);
    for (const row of s.prepare('SELECT id FROM platform_relation').all() as {
        id: number;
    }[])
        ensurePlatformObservation(legacyDb, row.id);
    s.close();
    copyFileSync(legacy, target);
    upgradeCollections({ source: legacy, target, runId: 'collections', batchSize: 10 });
    upgradeObservations({ source: legacy, target, runId: 'observations', collectionRunId: 'collections', batchSize: 10 });
    upgradeProjections({ source: legacy, target, runId: 'projections', observationRunId: 'observations', collectionRunId: 'collections', batchSize: 10 });
    const opts = { source: legacy, target, runId: 'final', projectionRunId: 'projections', observationRunId: 'observations', collectionRunId: 'collections' };
    finalizeObservations(opts);
    finalizeCollectionScopes({ ...opts, runId: 'scopes', finalizationRunId: 'final' });
    const p = join(root, '71606.sqlite');
    copyFileSync(target, p);
    finalizeFingerprintBasis({ source: p, target, runId: 'basis', predecessorRunId: 'scopes', legacySource: legacy });
    copyFileSync(target, source);
    return { source, target, legacySource: legacy, runId: 'stored', predecessorRunId: 'basis' };
}
import { targetSchema } from '../../upgrade/target-schema';
export function ready(seed?: Parameters<typeof fixture>[0]) { const f = fixture(seed); finalizeApplyStored(f); const t = new Database(f.target); t.pragma('foreign_keys=ON'); return { f, t, db: drizzle(t, { schema: targetSchema }) }; }
import { ensurePlatformObservation } from '../../upgrade/frozen/server/platform-business-record';
import * as legacySchema from '../../upgrade/legacy-schema';
export function records(db: ReturnType<typeof drizzle<typeof legacySchema>>) {
    db.$client.prepare("UPDATE platform_relation SET name_raw=' History ',uscc_raw=' U ' WHERE id=1").run();
    const ea = db.insert(legacySchema.enterprise).values({ name: 'Alpha', nameNorm: 'Alpha', usccNorm: 'UA' }).returning().get();
    const eb = db.insert(legacySchema.enterprise).values({ name: 'Beta', nameNorm: 'Beta', usccNorm: 'UB' }).returning().get();
    for (const [index, key, status, owner, time] of [[0, 'A', 'pending', ea.id, '2024-01'], [1, 'A', 'passed', eb.id, '2025-01'], [2, 'A', 'passed', ea.id, '2025-01'], [3, 'B', 'pending', null, null]] as const) {
        const q = db.insert(legacySchema.platformQuery).values({ interface: 'apply_list', queryKey: `q${index}`, rdjb: '2,3', queriedAt: 'same', lastCollectedAt: index === 1 ? 'z' : null, status: 'success' }).returning().get();
        db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: 1, relationKey: key, enterpriseId: owner, nameRaw: ' Original ', usccRaw: ' U ', status: index === 2 ? 'rejected' : status, rawFields: { id: key, rdjb: '2', cszt: status, sblx: '申请', year: '2024', sqsj: time } }).run();
    }
}
