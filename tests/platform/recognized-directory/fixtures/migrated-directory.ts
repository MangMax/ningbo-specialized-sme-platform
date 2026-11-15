import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';
import { join } from 'node:path';
import { candidateFixture } from '../../fixtures/candidate-scope-upgrade';
import { finalizeCandidateScopes } from '../../../../upgrade/candidate-scope';
import { finalizeRecognizedStored } from '../../../../upgrade/recognized-stored';
import { ensurePlatformObservation } from '../../../../upgrade/frozen/server/platform-business-record';
import * as schema from '../../../../upgrade/legacy-schema';
import { targetSchema } from '../../../../upgrade/target-schema';
async function buildRecognizedFixture(extra?: (old: Database.Database) => void) {
    const f = await candidateFixture(old => {
        const db = drizzle(old, { schema });
        for (const [id, name] of [[1, 'Alpha'], [2, 'Beta']] as const)
            db.insert(schema.enterprise).values({ id, name, nameNorm: name, usccNorm: `U${id}` }).run();
        const inputs = [
            { key: 'A', raw: { id: 'A', rdjb: '2', rddqrq: ' 2028 ', whpcyear: '2026', whpc: ' 2026-2 ', szq: ' D ', rdxx: ' Note ', qymc: ' Source ', tyshxydm: ' U1 ' }, scope: '2,3', owner: 1, time: 't2' },
            { key: 'A', raw: { id: 'A', rdjb: '2', rddqrq: ' 2028 ', whpcyear: '2026', whpc: ' 2026-2 ', szq: ' D ', rdxx: ' Note ', qymc: ' Source ', tyshxydm: ' U1 ' }, scope: '3', owner: 2, time: 't3' },
            { key: 'A', raw: { id: 'A', rdjb: '1', rddqrq: '2029', whpcyear: false, whpc: 'B', szq: 'E' }, scope: ' 1 , 2 ', owner: 1, time: 't1' },
            { key: 'B', raw: { id: 'B', rdjb: '3' }, scope: '3', owner: null, time: 't3' },
            { key: null, raw: { rdjb: '1' }, scope: '2,3', owner: 1, time: 't3' },
            { key: 'conflict', raw: { id: 'different', rdjb: 2 }, scope: '1,2', owner: null, time: 't3' },
        ];
        inputs.forEach((x, i) => {
            const q = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: `Q${i}`, rdjb: x.scope, queriedAt: x.time, lastCollectedAt: i === 0 ? 'z' : null, status: 'success' }).returning().get();
            old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(JSON.stringify({ pages: [{ status: 'success', rdjb: '3', fetchedCount: 1, page: 1 }] }), q.id);
            const r = db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, relationKey: x.key, enterpriseId: x.owner, nameRaw: ' Original ', usccRaw: ' U ', rawFields: x.raw }).returning().get();
            ensurePlatformObservation(db, r.id);
        });
        old.exec("UPDATE platform_relation SET title_raw='3' WHERE id=5");
        db.insert(schema.recordCorrespondence).values({ enterpriseId: 1, titleCode: 'specialized_sme', relationId: 1, edgeKey: 'edge', type: 'event_process', role: 'candidate', status: 'rejected', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'f', ruleId: 'r', ruleVersion: 'v', createdAt: 'c' }).run();
        extra?.(old);
    });
    finalizeCandidateScopes(f);
    const source = join(f.root, '71609.sqlite');
    copyFileSync(f.target, source);
    finalizeRecognizedStored({ source, target: f.target, runId: 'recognized', predecessorRunId: 'candidate' });
    return f;
}
let template: ReturnType<typeof buildRecognizedFixture> | undefined;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
export async function recognizedFixture(extra?: (old: Database.Database) => void) {
    // Reuse only the closed default seed; every test receives independent files.
    const pristine = extra ? await buildRecognizedFixture(extra) : await (template ??= buildRecognizedFixture());
    const root = mkdtempSync(join(tmpdir(), 'recognized-reader-')); roots.push(root);
    const f = { ...pristine, root, target: join(root, 'target.sqlite'), legacySource: join(root, 'legacy.sqlite') };
    copyFileSync(pristine.target, f.target); copyFileSync(pristine.legacySource, f.legacySource);
    const statements: string[] = [];
    const t = new Database(f.target, { verbose: q => statements.push(String(q)) });
    t.pragma('foreign_keys=ON');
    const legacy = new Database(f.legacySource, { readonly: true });
    return { ...f, t, db: drizzle(t, { schema: targetSchema }), legacy, old: drizzle(legacy, { schema }), statements, close() { legacy.close(); t.close(); } };
}
