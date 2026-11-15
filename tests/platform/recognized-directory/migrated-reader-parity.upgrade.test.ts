import { projectionManifest } from '../../../upgrade/projections';
import { expect, it } from 'vitest';
import { recognizedFixture } from './fixtures/migrated-directory';
import { listPlatformRecognizedDirectory, getPlatformRecognizedRecord } from '../../../upgrade/frozen/server/platform-recognized-directory';
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options';
import { listTargetRecognizedDirectory, getTargetRecognizedRecord, readTargetRecognizedOptions } from '../../../upgrade/frozen/server/platform-recognized-target';
it('preserves migrated directory records isolated exact titles and global options against independent old services', async () => {
    const f = await recognizedFixture();
    try {
        for (const view of ['records', 'isolated'] as const) {
            expect(listTargetRecognizedDirectory({ view }, f.db)).toEqual(listPlatformRecognizedDirectory({ view }, f.old));
            expect(readTargetRecognizedOptions(view, f.db)).toEqual(readPlatformFilterOptions({ source: 'recognized-directory', view }, f.old));
        }
    }
    finally {
        f.close();
    }
});
it('preserves full detail versions observations correspondence and per-observation conflicts against the old service', async () => {
    const f = await recognizedFixture();
    try {
        const list = listPlatformRecognizedDirectory({}, f.old);
        for (const row of list.rows)
            if (row.kind === 'record')
                expect(getTargetRecognizedRecord(f.db, row.record.id)).toEqual(getPlatformRecognizedRecord(f.old, row.record.id));
    }
    finally {
        f.close();
    }
});
it('preserves all title and value filters on the same matching version with whole-record counts and stable pages', async () => {
    const f = await recognizedFixture();
    try {
        const filters = [{}, ...['1', '2', '3'].map(rdjb => ({ rdjb })), ...['1', '2', '3'].map(titleRaw => ({ titleRaw })), { platformKey: 'A' }, { platformKey: 'missing' }, { enterpriseId: 1 }, { enterpriseId: 2 }, { q: 'Alpha' }, { q: 'U2' }, { rddqrq: '2028' }, { whpcyear: 2026 }, { whpc: '2026-2' }, { szq: 'D' }, { titleRaw: '1', whpcyear: 2026 }, { rdjb: '2', titleRaw: '2', rddqrq: '2028', whpcyear: 2026, whpc: '2026-2', szq: 'D' }];
        for (const view of ['records', 'isolated'] as const)
            for (const filter of filters)
                expect(listTargetRecognizedDirectory({ ...filter, view }, f.db), JSON.stringify({ filter, view })).toEqual(listPlatformRecognizedDirectory({ ...filter, view }, f.old));
        const selected = listTargetRecognizedDirectory({ titleRaw: '2', whpcyear: 2026 }, f.db);
        expect(selected).toMatchObject({ total: 1, rows: [{ record: { platformKey: 'A' }, matchedVersion: { validityDateRaw: '2028', maintenanceYear: 2026, maintenanceBatch: '2026-2', district: 'D', awardNote: 'Note', titleRaw: '2', nameRaw: 'Source', usccRaw: 'U1' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], titleScopes: ['1', '2', '3'], conflicts: ['title_conflict', 'enterprise_assignment_conflict'] }] });
        expect(listTargetRecognizedDirectory({ titleRaw: '1', whpcyear: 2026 }, f.db).total).toBe(0);
        expect(listTargetRecognizedDirectory({ view: 'isolated', titleRaw: '3' }, f.db)).toMatchObject({ total: 1, rows: [{ titleRaw: '3', relationId: 5, nameRaw: ' Original ' }] });
        for (const view of ['records', 'isolated'] as const)
            for (const page of [1, 2, 3, 5])
                expect(listTargetRecognizedDirectory({ view, page, pageSize: 1 }, f.db)).toEqual(listPlatformRecognizedDirectory({ view, page, pageSize: 1 }, f.old));
    }
    finally {
        f.close();
    }
});
it('keeps row query and page scope conflicts distinct and preserves literal correspondence references', async () => {
    const f = await recognizedFixture();
    try {
        const row = listPlatformRecognizedDirectory({ platformKey: 'A' }, f.old).rows[0]!;
        if (row.kind !== 'record')
            throw new Error('Expected record');
        const detail = getTargetRecognizedRecord(f.db, row.record.id);
        expect(detail.observations.map(o => [o.relationId, o.titleScopes, o.titleConflict])).toEqual([[2, ['3'], true], [1, ['2', '3'], false], [3, ['1', '2'], false]]);
        expect(detail.observations.find(o => o.relationId === 1)?.correspondenceRefs).toEqual([{ id: 1, status: 'rejected', revision: 1 }]);
        expect(detail.observations.find(o => o.relationId === 2)?.correspondenceRefs).toEqual([]);
        expect(detail.versions.map(v => v.observationCount)).toEqual([1, 2]);
        expect(detail.counts).toEqual({ versions: 2, observations: 3, versionsTruncated: false, observationsTruncated: false });
        expect(readTargetRecognizedOptions('isolated', f.db)).toEqual({ titles: ['3'], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] });
    }
    finally {
        f.close();
    }
});
import { sql } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
it('retains raw-only not-indexed observations NULL false whitespace and BLOB exact cells without borrowing display titles', async () => {
    const f = await recognizedFixture(old => old.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,created_at) VALUES(7,1,2,' Unindexed ','{"rdjb":false}','c'),(8,2,2,' NoRaw ',NULL,'c');UPDATE platform_relation SET title_raw='  ' WHERE id=7;UPDATE platform_relation SET title_raw=X'3200ff' WHERE id=8;`));
    try {
        const result = listTargetRecognizedDirectory({ view: 'isolated' }, f.db);
        expect(result).toMatchObject({ total: 4 });
        expect(result.rows.find(r => r.kind === 'observation' && r.relationId === 7)).toMatchObject({ titleRaw: '  ', nameRaw: ' Unindexed ', identityState: 'not_indexed', contentState: 'not_indexed', titleScopes: ['2', '3'] });
        expect(result.rows.find(r => r.kind === 'observation' && r.relationId === 8)).toMatchObject({ titleRaw: Buffer.from('3200ff', 'hex'), nameRaw: ' NoRaw ', identityState: 'not_indexed' });
        expect(readTargetRecognizedOptions('isolated', f.db).titles).toEqual(['3', Buffer.from('3200ff', 'hex')]);
        expect(listTargetRecognizedDirectory({ view: 'isolated', titleRaw: '  ' }, f.db).total).toBe(1);
        expect(listTargetRecognizedDirectory({ view: 'isolated', titleRaw: '2' }, f.db).total).toBe(0);
    }
    finally {
        f.close();
    }
});
it('reads latest assignment revisions freshly while retaining original name and independent shared-version owners', async () => {
    const f = await recognizedFixture();
    try {
        const oldBefore = listTargetRecognizedDirectory({ enterpriseId: 2 }, f.db);
        expect(oldBefore.total).toBe(1);
        f.t.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,uscc_raw,origin) VALUES(2,2,1,'manual','pending','Changed','Changed','command')");
        expect(listTargetRecognizedDirectory({ enterpriseId: 2 }, f.db).total).toBe(0);
        const after = listTargetRecognizedDirectory({ platformKey: 'A' }, f.db);
        expect(after.rows).toMatchObject([{ enterpriseIds: [1], enterpriseNames: ['Alpha'], conflicts: ['title_conflict'] }]);
        f.t.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) VALUES(5,2,2,'manual','pending','command')");
        expect(listTargetRecognizedDirectory({ view: 'isolated', enterpriseId: 2 }, f.db)).toMatchObject({ total: 1, rows: [{ enterpriseId: 2, enterpriseName: 'Beta', nameRaw: ' Original ', usccRaw: ' U ' }] });
    }
    finally {
        f.close();
    }
});
it('rejects uncaptured original title even for zero-result filters and options without parsing evidence', async () => {
    const f = await recognizedFixture();
    try {
        const barrier = f.t.prepare("SELECT sql FROM sqlite_schema WHERE name='recognized_stored_update'").get() as {
            sql: string;
        };
        f.t.exec("DROP TRIGGER recognized_stored_update;UPDATE platform_recognized_projection SET exact_title_state='uncaptured' WHERE observation_id=5");
        f.t.exec(barrier.sql);
        expect(() => listTargetRecognizedDirectory({ platformKey: 'missing' }, f.db)).toThrow('uncaptured');
        expect(() => listTargetRecognizedDirectory({ view: 'isolated', rddqrq: 'not-matchable' }, f.db)).toThrow('uncaptured');
        expect(() => readTargetRecognizedOptions('isolated', f.db)).toThrow('uncaptured');
        expect(() => getTargetRecognizedRecord(f.db, 1)).toThrow('uncaptured');
    }
    finally {
        f.close();
    }
});
it('rejects missing assignment aliases and original revision rather than silently discarding observations', async () => {
    const f = await recognizedFixture();
    try {
        f.t.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) VALUES(5,2,1,'manual','pending','command')");
        const snapshot = () => JSON.stringify(f.t.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()) + projectionManifest(f.t) + JSON.stringify(f.t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all());
        const snapshots = snapshot();
        for (const [table, statement] of [
            ['platform_legacy_relation_alias', "DELETE FROM platform_legacy_relation_alias WHERE observation_id=5"],
            ['platform_legacy_query_alias', "DELETE FROM platform_legacy_query_alias WHERE collection_id=5"],
            ['platform_observation_assignment', "DELETE FROM platform_observation_assignment WHERE observation_id=5 AND revision=1"],
        ] as const) {
            expect(() => f.db.transaction(tx => {
                const triggers = f.t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as {
                    name: string;
                    sql: string;
                }[];
                for (const t of triggers)
                    f.t.exec(`DROP TRIGGER "${t.name}"`);
                f.t.exec(statement);
                for (const t of triggers)
                    f.t.exec(t.sql);
                expect(() => listTargetRecognizedDirectory({ view: 'isolated' }, tx)).toThrow('uncaptured');
                throw new Error('rollback');
            })).toThrow('rollback');
        }
        expect(snapshot()).toEqual(snapshots);
    }
    finally {
        f.close();
    }
});
it('bounds SQL hydration after paging and records actual indexes and temporary sorting without legacy or archive business reads', async () => {
    const f = await recognizedFixture();
    try {
        f.statements.length = 0;
        const result = listTargetRecognizedDirectory({ pageSize: 1 }, f.db);
        expect(result.rows).toHaveLength(1);
        const listStatements = [...f.statements];
        getTargetRecognizedRecord(f.db, 1);
        readTargetRecognizedOptions('records', f.db);
        readTargetRecognizedOptions('isolated', f.db);
        listTargetRecognizedDirectory({titleRaw:'2',whpcyear:2026,pageSize:1},f.db);
        listTargetRecognizedDirectory({view:'isolated',titleRaw:'3',pageSize:1},f.db);
        const statements = [...f.statements];
        const text = statements.join('\n');
        expect(text).not.toMatch(/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s/i);
        expect(text).not.toMatch(/\b(?:from|join)\s+["`]?platform_archive_value|\bjson_\w*\s*\(/i);
        expect(text).not.toMatch(/canonical_raw_json|legacyRowSnapshot|candidate_scope_mask/);
        const page = statements.find(q => q.startsWith('with "matched"') && q.includes('limit 1'));
        expect(page).toBeDefined();
        expect(page).toContain('row_number() over');
        const plan = page ? f.t.prepare('EXPLAIN QUERY PLAN ' + page).all() : [];
        expect(plan.length).toBeGreaterThan(0);
        const selected = result.rows[0];
        if (selected?.kind !== 'record')
            throw new Error('Expected record');
        // All subsequent content/owner hydration queries restrict the selected record ID.
        const pageIndex = page ? statements.indexOf(page) : -1;
        const hydration = listStatements.slice(pageIndex + 1).filter(q => /^select/i.test(q) && /from "platform_business_observation"|from "platform_business_record_version"/.test(q));
        expect(hydration.length).toBeGreaterThan(0);
        expect(hydration.filter(q => !new RegExp('\\bin \\(' + selected.record.id + '(?:\\.0)?\\)|record_id" = ' + selected.record.id + '(?:\\.0)?').test(q))).toEqual([]);
        writeFileSync(join(f.root, 'TRACE.json'), JSON.stringify(statements, null, 2));
        writeFileSync(join(f.root, 'PLAN.json'), JSON.stringify(statements.filter(q => /^(select|with)/i.test(q) && !/sqlite_schema|pragma_|platform_migration/.test(q)).map(query => ({query,plan:f.t.prepare('EXPLAIN QUERY PLAN '+query).all()})), null, 2));
    }
    finally {
        f.close();
    }
});
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { targetSchema } from '../../../upgrade/target-schema';
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record';
import * as legacySchema from '../../../upgrade/legacy-schema';
it('pins count page owners and conflicts to one SQLite snapshot while the next request observes a new revision', async () => {
    const f = await recognizedFixture();
    f.t.pragma('journal_mode=WAL');
    const writer = new Database(f.target);
    writer.pragma('foreign_keys=ON');
    let changed = false;
    const reader = new Database(f.target, { verbose: q => {
            if (!changed && String(q).startsWith('select count(distinct')) {
                changed = true;
                writer.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) VALUES(2,2,1,'manual','pending','command')");
            }
        } });
    try {
        const db = drizzle(reader, { schema: targetSchema });
        expect(listTargetRecognizedDirectory({ enterpriseId: 2 }, db)).toMatchObject({ total: 1, rows: [{ enterpriseIds: [1, 2], conflicts: ['title_conflict', 'enterprise_assignment_conflict'] }] });
        expect(changed).toBe(true);
        expect(listTargetRecognizedDirectory({ enterpriseId: 2 }, db).total).toBe(0);
    }
    finally {
        reader.close();
        writer.close();
        f.close();
    }
});
it('keeps global counts options and scopes beyond detail truncation while preserving stable timestamp ties', async () => {
    const f = await recognizedFixture(old => {
        const db = drizzle(old, { schema: legacySchema });
        for (let i = 0; i < 201; i++) {
            const r = db.insert(legacySchema.platformRelation).values({ queryId: 1, sequenceNo: i + 2, relationKey: 'Limit', rawFields: { id: 'Limit', rdjb: '2', whpc: `L${i % 101}` } }).returning().get();
            ensurePlatformObservation(db, r.id);
        }
    });
    try {
        const oldRows = listPlatformRecognizedDirectory({ platformKey: 'Limit' }, f.old);
        const selected = listTargetRecognizedDirectory({ platformKey: 'Limit' }, f.db);
        expect(selected).toEqual(oldRows);
        expect(selected).toMatchObject({ rows: [{ versionCount: 101, observationCount: 201, matchedVersionCount: 101 }] });
        const row = oldRows.rows[0];
        if (row?.kind !== 'record')
            throw new Error('Expected record');
        const detail = getTargetRecognizedRecord(f.db, row.record.id);
        expect(detail).toEqual(getPlatformRecognizedRecord(f.old, row.record.id));
        expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true });
        expect(detail.versions).toHaveLength(100);
        expect(detail.observations).toHaveLength(200);
        expect(detail.observations.slice(0,2).map(o=>o.relationId)).toEqual([207,206]);
        expect(detail.observations.at(-1)?.relationId).toBe(8);
        expect(listTargetRecognizedDirectory({},f.db).rows.map(r=>r.kind==='record'?r.record.platformKey:null)).toEqual(['Limit','A','B']);
        expect(readTargetRecognizedOptions('records', f.db)).toEqual(readPlatformFilterOptions({ source: 'recognized-directory', view: 'records' }, f.old));
        expect(readTargetRecognizedOptions('records', f.db).batches).toContain('L0');
    }
    finally {
        f.close();
    }
}, 30000);
it('preserves input errors missing detail and explicit capture catalog guard without changing public schema', async () => {
    const f = await recognizedFixture();
    try {
        for (const input of [{ page: 0 }, { view: 'other' }, { unknown: 'field' }, { whpcyear: false }])
            expect(() => listTargetRecognizedDirectory(input, f.db)).toThrow('Invalid recognized directory');
        for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
            expect(() => getTargetRecognizedRecord(f.db, id)).toThrow('positive safe integer');
        expect(() => getTargetRecognizedRecord(f.db, 999)).toThrow('not found');
        const before = f.t.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
        listTargetRecognizedDirectory({}, f.db);
        getTargetRecognizedRecord(f.db, 1);
        readTargetRecognizedOptions('records', f.db);
        expect(f.t.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(before);
        f.t.pragma('user_version=71608');
        expect(() => listTargetRecognizedDirectory({}, f.db)).toThrow('Recognized reader requires completed 71609 stored-title capture');
    }
    finally {
        f.close();
    }
});
it('preserves different directory filter display and conflict scope predicates including indexed whitespace and invalid evidence', async () => {
    const f = await recognizedFixture(old => {
        const db = drizzle(old, { schema: legacySchema });
        for (const [id, key, rdjb, title, evidence] of [[7, 'Unicode', '\u00a02\u00a0', '2', null], [8, 'Indexed', '', '1', JSON.stringify({ titleScope: { rdjb: ['2', ' 3 ', 'x'] } })], [9, 'InvalidEvidence', '3', '3', '{']] as const) {
            const q = db.insert(legacySchema.platformQuery).values({ id, interface: 'recognized_list', queryKey: key, rdjb, queriedAt: 't4', status: 'success' }).returning().get();
            if (evidence !== null)
                old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(evidence, id);
            const r = db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: 1, relationKey: key, rawFields: { id: key, rdjb: title } }).returning().get();
            ensurePlatformObservation(db, r.id);
        }
    });
    try {
        for (const platformKey of ['Unicode', 'Indexed', 'InvalidEvidence'])
            for (const rdjb of [undefined, '1', '2', '3'])
                expect(listTargetRecognizedDirectory({ platformKey, rdjb }, f.db)).toEqual(listPlatformRecognizedDirectory({ platformKey, rdjb }, f.old));
        const unicode = listTargetRecognizedDirectory({ platformKey: 'Unicode' }, f.db).rows[0];
        if (unicode?.kind !== 'record')
            throw new Error('Expected record');
        expect(unicode).toMatchObject({ titleScopes: ['2'], conflicts: ['title_conflict'] });
        expect(getTargetRecognizedRecord(f.db, unicode.record.id).observations[0]).toMatchObject({ titleScopes: ['2'], titleConflict: false });
        expect(listTargetRecognizedDirectory({ platformKey: 'Unicode', rdjb: '2' }, f.db).total).toBe(0);
        expect(listTargetRecognizedDirectory({ platformKey: 'Indexed', rdjb: '2', titleRaw: '1' }, f.db)).toMatchObject({ total: 1, rows: [{ titleScopes: ['2', ' 3 ', 'x'], conflicts: ['title_conflict'] }] });
        expect(listTargetRecognizedDirectory({ platformKey: 'InvalidEvidence', rdjb: '3' }, f.db).total).toBe(1);
    }
    finally {
        f.close();
    }
});
