import type Database from 'better-sqlite3'
import { runtimeCapabilities, runtimeSchemaHash, runtimeSchemaStatements } from '../../db/runtime-schema.generated'
import { TITLE_SEED } from '../../db/titles'
import type { EnterpriseDictionaries } from '../../upgrade/enterprise-dictionaries'

/** Frozen native 71613 setup for tests that exercise commands owned by that phase. */
export function createPreEnterpriseKernelFixture(sqlite: Database.Database) {
  sqlite.pragma('foreign_keys = ON')
  sqlite.transaction(() => {
    for (const statement of runtimeSchemaStatements) sqlite.exec(statement)
    sqlite.exec('CREATE TABLE platform_runtime_capability(transform_version TEXT PRIMARY KEY)')
    const capability = sqlite.prepare('INSERT INTO platform_runtime_capability VALUES(?)')
    for (const value of runtimeCapabilities) capability.run(value)
    const title = sqlite.prepare('INSERT INTO title(code,name_zh,level,rank) VALUES(?,?,?,?)')
    for (const value of TITLE_SEED) title.run(value.code, value.nameZh, value.level, value.rank)
    sqlite.exec("INSERT INTO platform_legacy_alias_sequence(namespace,high_water) VALUES ('query',0),('relation',0)")
    sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,71613)').run(runtimeSchemaHash)
    sqlite.exec("INSERT INTO platform_runtime_completion VALUES(1,'platform-mixed-model-retirement-v1',71613,'2026-11-18')")
    sqlite.pragma('user_version = 71613')
  }).immediate()
}

export const syntheticEnterpriseDictionaries: EnterpriseDictionaries = {
  regionSha256: 'a'.repeat(64),
  industrySha256: 'b'.repeat(64),
  regions: [{ code: '330200', name: '宁波市', parent: null, level: 1 }],
  industries: [{ code: 'A', inputId: '1', name: '合成行业', parent: null, level: 0, description: null }],
}
