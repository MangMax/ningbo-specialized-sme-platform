import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';
import * as s from '../../../db/schema';
import { getEnterpriseProfile } from '../../../server/utils/enterprise-profile'
import { runtimeSchemaStatements } from '../../../db/runtime-schema.generated';
import { upgradeTitleCycleDisposition } from '../../../db/title-cycle-disposition';
import { currentDispositions, historyDispositions } from '../../../server/utils/title-cycle-disposition';
it('adds disposition storage twice without changing retained enterprise data', () => {
    const sqlite = new Database(':memory:');
    try {
        sqlite.pragma('foreign_keys=ON');
        // Pre-disposition native schema: additive upgrade must create the missing tables.
        for (const statement of runtimeSchemaStatements)
            if (!statement.includes('title_cycle_disposition_')) sqlite.exec(statement);
        const db = drizzle(sqlite, { schema: s });
        const enterprise = db.insert(s.enterprise).values({ name: '保留企业', nameNorm: '保留企业' }).returning().get();
        const before=getEnterpriseProfile(db,enterprise.id);
    upgradeTitleCycleDisposition(sqlite);
        upgradeTitleCycleDisposition(sqlite);
        expect(getEnterpriseProfile(db,enterprise.id)).toEqual(before);
        expect(currentDispositions(db, [enterprise.id]).rows).toEqual([]);
        expect(historyDispositions(db, [enterprise.id])).toEqual([]);
    }
    finally {
        sqlite.close();
    }
});

it('opens an existing pre-disposition native database without installing tables', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { useRuntimeDb } = await import('../../../db/client');
    const dir = mkdtempSync(join(tmpdir(), 'disposition-open-'));
    const path = join(dir, 'db');
    let runtime: ReturnType<typeof useRuntimeDb> | undefined;
    const sqlite = new Database(path);
    try {
        for (const statement of runtimeSchemaStatements)
            if (!statement.includes('title_cycle_disposition_')) sqlite.exec(statement);
        sqlite.pragma('user_version=71613');
        sqlite.prepare('INSERT INTO platform_runtime_completion VALUES(1,?,?,?)').run('platform-mixed-model-retirement-v1', 71613, '2026-01-01');
        const before = sqlite.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
        runtime = useRuntimeDb({ dbPath: path });
        expect(sqlite.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(before);
        expect(() => currentDispositions(runtime!, [1])).toThrow(/no such table/);
        upgradeTitleCycleDisposition(sqlite);
        expect(currentDispositions(runtime, [1]).rows).toEqual([]);
    } finally {
        runtime?.$client.close();
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
