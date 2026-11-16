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
        for (const statement of runtimeSchemaStatements)
            sqlite.exec(statement);
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
