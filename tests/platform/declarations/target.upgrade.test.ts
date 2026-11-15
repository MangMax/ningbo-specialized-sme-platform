import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upgradeCollections } from '../../../upgrade/collections';
import { upgradeObservations } from '../../../upgrade/observations';
import { upgradeProjections } from '../../../upgrade/projections';
import { finalizeObservations, finalizeCollectionScopes } from '../../../upgrade/finalize-observations';
import { finalizeFingerprintBasis } from '../../../upgrade/fingerprint-basis';
import { finalizeApplyStored } from '../../../upgrade/apply-stored';
type Seed = (db: ReturnType<typeof drizzle<typeof legacySchema>>) => void;
const prefixTemplates = new Map<Seed | undefined, { source: string; target: string; legacySource: string; runId: string; predecessorRunId: string }>();
const fixtureRoots: string[] = [];
afterAll(() => {
    if (!process.env.APPLY_STORED_EVIDENCE_DIR)
        for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});
function fixture(seed?: (db: ReturnType<typeof drizzle<typeof legacySchema>>) => void) {
    const root = mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR ?? tmpdir(), 'apply-stored-'));
    const legacy = join(root, 'legacy.sqlite'), target = join(root, 'target.sqlite'), source = join(root, '71607.sqlite');
    fixtureRoots.push(root);
    const template = prefixTemplates.get(seed);
    if (template) {
        copyFileSync(template.legacySource, legacy);
        copyFileSync(template.target, target);
        copyFileSync(template.source, source);
        return { source, target, legacySource: legacy, runId: 'stored', predecessorRunId: 'basis' };
    }
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
    // These files have no open handles and precede the finalizer under test.
    // Retain a separate immutable copy: callers may mutate every returned path.
    const pristine = mkdtempSync(join(root, 'pristine-'));
    const frozen = { source: join(pristine, 'source.sqlite'), target: join(pristine, 'target.sqlite'), legacySource: join(pristine, 'legacy.sqlite'), runId: 'stored', predecessorRunId: 'basis' };
    copyFileSync(source, frozen.source);
    copyFileSync(target, frozen.target);
    copyFileSync(legacy, frozen.legacySource);
    prefixTemplates.set(seed, frozen);
    return { source, target, legacySource: legacy, runId: 'stored', predecessorRunId: 'basis' };
}
import { targetSchema } from '../../../upgrade/target-schema';
import { writeApplyTarget, type ApplyTargetInput } from '../../../upgrade/frozen/apply-target-writer';
import { verifyFingerprint } from '../../../upgrade/frozen/fingerprint-verifier';
import { createHash } from 'node:crypto';
const readyTemplates = new Map<Seed | undefined, string>();
function ready(seed?: Parameters<typeof fixture>[0]) {
    const f = fixture(seed), template = readyTemplates.get(seed);
    if (template) copyFileSync(template, f.target);
    else {
        finalizeApplyStored(f);
        const frozen = join(mkdtempSync(join(f.target, '..', 'ready-')), 'target.sqlite');
        copyFileSync(f.target, frozen); readyTemplates.set(seed, frozen);
    }
    const t = new Database(f.target); t.pragma('foreign_keys=ON');
    return { f, t, db: drizzle(t, { schema: targetSchema }) };
}
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record';
import * as legacySchema from '../../../upgrade/legacy-schema';
import { listPlatformDeclarations } from '../../../upgrade/frozen/server/platform-declarations';
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options';
import { listTargetDeclarations, readTargetDeclarationOptions } from '../../../upgrade/frozen/server/platform-declarations-target';
it('retains the legacy isolated stored status distinction in structured target facts', () => {
    const { f, t, db } = ready(), old = new Database(f.legacySource), legacy = drizzle(old, { schema: legacySchema });
    const input = { view: 'isolated', status: 'pending' };
    expect(listPlatformDeclarations(input, legacy).total).toBe(1);
    expect(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy).statuses).toEqual([' pending ', 'pending']);
    expect(listTargetDeclarations(input, db)).toEqual(listPlatformDeclarations(input, legacy));
    expect(readTargetDeclarationOptions('isolated', db)).toEqual(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy));
    old.close();
    t.close();
});
import { getPlatformDeclaration, readPlatformDeclarationFacts } from '../../../upgrade/frozen/server/platform-declarations';
import { getTargetDeclaration, readTargetDeclarationFacts } from '../../../upgrade/frozen/server/platform-declarations-target';
import { writeCollectionTarget } from '../../../upgrade/frozen/collection-target-command';
import { writeFileSync } from 'node:fs';
function records(db: ReturnType<typeof drizzle<typeof legacySchema>>) {
    db.$client.prepare("UPDATE platform_relation SET name_raw=' History ',uscc_raw=' U ' WHERE id=1").run();
    const ea = db.insert(legacySchema.enterprise).values({ name: 'Alpha', nameNorm: 'Alpha', usccNorm: 'UA' }).returning().get();
    const eb = db.insert(legacySchema.enterprise).values({ name: 'Beta', nameNorm: 'Beta', usccNorm: 'UB' }).returning().get();
    for (const [index, key, status, owner, time] of [[0, 'A', 'pending', ea.id, '2024-01'], [1, 'A', 'passed', eb.id, '2025-01'], [2, 'A', 'passed', ea.id, '2025-01'], [3, 'B', 'pending', null, null]] as const) {
        const q = db.insert(legacySchema.platformQuery).values({ interface: 'apply_list', queryKey: `q${index}`, rdjb: '2,3', queriedAt: 'same', lastCollectedAt: index === 1 ? 'z' : null, status: 'success' }).returning().get();
        db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: 1, relationKey: key, enterpriseId: owner, nameRaw: ' Original ', usccRaw: ' U ', status: index === 2 ? 'rejected' : status, rawFields: { id: key, rdjb: '2', cszt: status, sblx: '申请', year: '2024', sqsj: time } }).run();
    }
}
function compare(f: ReturnType<typeof ready>, inputs: unknown[]) {
    const old = new Database(f.f.legacySource), legacy = drizzle(old, { schema: legacySchema });
    const sourceBefore=old.serialize(),targetBefore=f.t.serialize();
    for (const input of inputs)
        expect(listTargetDeclarations(input, f.db), JSON.stringify(input)).toEqual(listPlatformDeclarations(input, legacy));
    for (const view of ['records', 'isolated'] as const)
        expect(readTargetDeclarationOptions(view, f.db)).toEqual(readPlatformFilterOptions({ source: 'declarations', view }, legacy));
    const ids = old.prepare('SELECT id FROM platform_relation ORDER BY id').all().map(r => Reflect.get(r as object, 'id') as number);
    expect(readTargetDeclarationFacts(f.db, ids)).toEqual(readPlatformDeclarationFacts(legacy, ids));
    for (const r of old.prepare('SELECT id FROM platform_business_record').all() as {
        id: number;
    }[])
        expect(getTargetDeclaration(f.db, r.id)).toEqual(getPlatformDeclaration(legacy, r.id));
    expect(old.serialize().equals(sourceBefore), 'database bytes remain unchanged').toBe(true);expect(f.t.serialize().equals(targetBefore), 'database bytes remain unchanged').toBe(true);
    old.close();
}
it('matches independent legacy records matched versions whole record counts owners conflicts stable pages detail and per observation facts', () => {
    const f = ready(records);
    compare(f, [{}, { status: 'pending' }, { status: 'passed' }, { year: 2024 }, { declareKind: '申请' }, { titleRaw: '2' }, { titleRaw: '3' }, { platformKey: 'A' }, { enterpriseId: 1 }, { q: 'Alpha' }, { pageSize: 1 }, { pageSize: 1, page: 2 }, { page: 99 }, { view: 'isolated' }]);
    expect(listTargetDeclarations({ status: 'pending' }, f.db).rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], conflicts: ['enterprise_assignment_conflict'] });
    const facts = readTargetDeclarationFacts(f.db, [5]);
    expect(facts.get(5)).toMatchObject({ status: 'passed', normalizationConflicts: [{ field: 'status', storedValue: 'rejected', rawValue: 'passed' }], archiveProcessFacts: { status: null } });
    f.t.close();
});
it('preserves isolated null empty tab unknown values exact filters and BINARY option ordering', () => {
    const f = ready(db => {
        for (const [index, status] of [null, '', ' ', ' pending ', 'pending', '\t', 'toString'].entries()) {
            db.insert(legacySchema.platformRelation).values({ queryId: 1, sequenceNo: index + 3, status, declareKind: null, year: index === 0 ? null : index === 1 ? 0 : index === 2 ? -1 : 2024, nameRaw: ' Old ', appliedAt: index === 0 ? null : index === 1 ? '' : index === 2 ? ' 2026 ' : '2026', rawFields: { rdjb: ' 2 ' } }).run();
            db.$client.prepare('UPDATE platform_relation SET declare_kind=? WHERE query_id=1 AND sequence_no=?').run(['申请','apply',' apply ',null,'','toString','review'][index],index+3);
        }
    });
    compare(f, [{ view: 'isolated' }, { view: 'isolated', status: 'pending' }, { view: 'isolated', declareKind: '申请' }, { view: 'isolated', year: 2024 }, { view: 'isolated', titleRaw: '2' }, { view: 'isolated', pageSize: 2, page: 2 }, { view: 'isolated', platformKey: 'no' }]);
    expect(readTargetDeclarationOptions('isolated', f.db).statuses).toEqual(['\t', ' pending ', 'pending', 'toString']);
    f.t.close();
});
it('keeps SQL fact title duplicate keys independent of history exact title and shared version parser title', () => {
    const f = ready();
    expect(listTargetDeclarations({ view: 'isolated', titleRaw: 'X' }, f.db).total).toBe(2);
    const facts = readTargetDeclarationFacts(f.db, [1, 2]);
    expect([...facts.values()].map(f => f.titleRaw)).toEqual(['2', '1']);
    expect([...facts.values()].map(f => f.status)).toEqual(['pending', 'pending']);
    compare(f, [{ view: 'isolated', titleRaw: 'X' }, { view: 'isolated', titleRaw: '2' }]);
    f.t.close();
});
it('uses revision1 raw names and latest revision attribution without changing immutable facts', () => {
    const f = ready(records), old = new Database(f.f.legacySource), legacy = drizzle(old, { schema: legacySchema });
    f.t.prepare("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,name_raw,uscc_raw,match_basis,verification_status,origin,actor,basis) VALUES(1,2,2,'New','NEW','manual','confirmed','command','{\"type\":\"agent\",\"id\":\"R\"}','correction')").run();
    old.prepare('UPDATE platform_relation SET enterprise_id=2 WHERE id=1').run();
    expect(listTargetDeclarations({ view: 'isolated', enterpriseId: 2 }, f.db)).toEqual(listPlatformDeclarations({ view: 'isolated', enterpriseId: 2 }, legacy));
    expect(listTargetDeclarations({ view: 'isolated' }, f.db).rows.find(r => r.kind === 'observation' && r.relationId === 1)).toMatchObject({ nameRaw: ' History ', enterpriseId: 2, enterpriseName: 'Beta' });
    old.close();
    f.t.close();
});
it('refuses phase and uncaptured owners before filtering empty pages counts or options and preserves errors', () => {
    const f = ready(records);
    for (const input of [{ year: '2024' }, { page: 0 }, { unknown: true }])
        expect(() => listTargetDeclarations(input, f.db)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'invalid_declaration_filter' }));
    expect(() => getTargetDeclaration(f.db, 0)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'invalid_declaration_id' }));
    expect(() => getTargetDeclaration(f.db, 99999)).toThrowError(expect.objectContaining({ statusCode: 404, code: 'declaration_not_found' }));
    f.t.exec('DROP TRIGGER platform_apply_stored_no_update; PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF; UPDATE platform_apply_projection SET sql_fact_title_state=NULL WHERE observation_id=1');
    const before = f.t.serialize();
    expect(() => listTargetDeclarations({ platformKey: 'absent', page: 999 }, f.db)).toThrow(/uncaptured/);
    expect(() => readTargetDeclarationOptions('records', f.db)).toThrow(/uncaptured/);
    expect(() => readTargetDeclarationFacts(f.db, [1])).toThrow(/uncaptured/);
    expect(f.t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);
    f.t.pragma('user_version=71607');
    expect(() => listTargetDeclarations({}, f.db)).toThrow(/71608/);
    f.t.close();
});
it('reads fresh W command ordinary and reference replay through target aliases without legacy entity access', () => {
    const f = ready();
    const command = { queryText: JSON.stringify({ interface: 'apply_list', queryKey: 'new', rdjb: '2', queriedAt: 'newtime', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, status: ' pending ', declareKind: '申请', rawFields: { id: 'NEW', rdjb: ' 2 ', cszt: 'pending', year: '2024' } }] }), evidenceText: null, createdAt: 'creation', assignments: [{ matchBasis: 'none' as const, verificationStatus: 'pending' as const, origin: 'command' as const, actor: { type: 'agent' as const, id: 'R' }, basis: 'explicit' }] };
    f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=1000 WHERE namespace='relation'; UPDATE platform_legacy_alias_sequence SET high_water=2000 WHERE namespace='query'");
    const written = writeCollectionTarget(f.db, command);
    expect(written.observations[0]!.relationAlias).toBe(1001);
    expect(written.observations[0]!.observationId).not.toBe(1001);
    expect(writeCollectionTarget(f.db, command).reused).toBe(true);
    const q = JSON.parse(command.queryText);
    q.reuseExisting = true;
    delete q.rawResponse;
    delete q.status;
    q.relations = [{ sequenceNo: 1 }];
    expect(writeCollectionTarget(f.db, { ...command, queryText: JSON.stringify(q), assignments: [] }).reused).toBe(true);
    const row = listTargetDeclarations({ platformKey: 'NEW' }, f.db);
    expect(row.total).toBe(1);
    expect(row.rows[0]).toMatchObject({ matchedVersion: { status: 'pending', declarationYear: 2024 }, versionCount: 1, observationCount: 1 });
    expect(readTargetDeclarationOptions('records', f.db).statuses).toEqual(['pending']);
    expect(getTargetDeclaration(f.db, written.observations[0]!.recordId!)).toMatchObject({ counts: { versions: 1, observations: 1 } });
    expect(readTargetDeclarationFacts(f.db, [written.observations[0]!.relationAlias]).size).toBe(1);
    expect(getTargetDeclaration(f.db,written.observations[0]!.recordId!).observations[0]!.queryId).toBe(2001);
    f.t.close();
});
it('executes bounded page hydration with target only SQL and records concrete EXPLAIN plans without mutating source or catalog', () => {
    const f = ready(records), statements: {
        sql: string;
        params: unknown[];
    }[] = [];
    const db = drizzle(f.t, { schema: targetSchema, logger: { logQuery(sql, params) { statements.push({ sql, params }); } } });
    const before = f.t.serialize(), catalog = f.t.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    listTargetDeclarations({ pageSize: 1 }, db);
    const listStatements = statements.slice();
    getTargetDeclaration(db, 1);
    readTargetDeclarationOptions('isolated', db);
    readTargetDeclarationFacts(db, [1, 2, 3, 4, 5, 6]);
    expect(statements.map(r => r.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation)\b|\bjson\w*\s*\(/i);
    expect(listStatements.length).toBeLessThanOrEqual(9);
    const plans = listStatements.filter(r => /^(select|with)/i.test(r.sql)).map(r => ({ ...r, plan: f.t.prepare('EXPLAIN QUERY PLAN ' + r.sql).all(...r.params) }));
    if (process.env.APPLY_STORED_EVIDENCE_DIR)
        writeFileSync(join(process.env.APPLY_STORED_EVIDENCE_DIR, 'SQL-EXPLAIN.json'), JSON.stringify({ statements, plans, catalog }, null, 2));
    expect(plans.some(p => JSON.stringify(p.plan).includes('INDEX'))).toBe(true);
    expect(f.t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);
    expect(f.t.pragma('foreign_key_check')).toEqual([]);
    expect(f.t.pragma('integrity_check', { simple: true })).toBe('ok');
    f.t.close();
});
it('detail limits preserve whole record history counts with 101 versions and 201 observations', () => {
    const f = ready(db => {
        const q = db.insert(legacySchema.platformQuery).values({ interface: 'apply_list', queryKey: 'many', rdjb: '2', queriedAt: 'zz', status: 'success' }).returning().get();
        for (let i = 0; i < 201; i++)
            db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: i + 1, relationKey: 'MANY', nameRaw: 'original', rawFields: { id: 'MANY', rdjb: '2', cszt: String(i % 101) } }).run();
    });
    compare(f, [{}, { status: '0' }, { pageSize: 1, page: 2 }]);
    const id = listTargetDeclarations({ platformKey: 'MANY' }, f.db).rows[0]!;
    if (id.kind !== 'record')
        throw new Error('Expected record');
    const detail = getTargetDeclaration(f.db, id.record.id);
    expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true });
    expect(detail.versions).toHaveLength(100);
    expect(detail.observations).toHaveLength(200);
    f.t.close();
}, 30000);
it('preserves driver REAL TEXT BLOB year cells and excludes them from integer options without repairing legacy values', () => {
    const f = ready(), old = new Database(f.f.legacySource), legacy = drizzle(old, { schema: legacySchema });
    // Predecessor migration cannot carry REAL process year. This is a reader cell
    // oracle only: edit independent synthetic copies after a legal migration.
    f.t.exec('DROP TRIGGER platform_apply_stored_no_update');
    for (const value of [2024.5, 'bad', Buffer.from('2024'), 2024, null]) {
        old.prepare('UPDATE platform_relation SET year=? WHERE id=1').run(value);
        f.t.prepare('UPDATE platform_apply_projection SET exact_year=? WHERE observation_id=1').run(value);
        expect(listTargetDeclarations({ view: 'isolated' }, f.db)).toEqual(listPlatformDeclarations({ view: 'isolated' }, legacy));
        expect(listTargetDeclarations({ view: 'isolated', year: 2024 }, f.db)).toEqual(listPlatformDeclarations({ view: 'isolated', year: 2024 }, legacy));
        expect(readTargetDeclarationOptions('isolated', f.db)).toEqual(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy));
    }
    old.close();
    f.t.close();
});
it('retains unresolved content on a resolved record and combines observation and owner conflicts without inflating version counts', () => {
    const f=ready(db=>{
        records(db);
        db.insert(legacySchema.platformRelation).values({queryId:1,sequenceNo:9,relationKey:'A',status:'unknown',rawFields:null}).run();
    });
    compare(f,[{platformKey:'A'},{view:'isolated',platformKey:'A'},{status:'passed',enterpriseId:1}]);
    expect(listTargetDeclarations({platformKey:'A'},f.db).rows[0]).toMatchObject({matchedVersionCount:2,versionCount:2,observationCount:4,conflicts:['unverifiable_observation','enterprise_assignment_conflict']});
    f.t.close();
});
