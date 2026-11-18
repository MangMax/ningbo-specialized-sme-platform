import type Database from 'better-sqlite3'
import { runtimeSchemaStatements, runtimeCapabilities, runtimeSchemaHash } from './runtime-schema.generated'
import { assertApplicationSchema, PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION } from './schema-phase'
import { TITLE_SEED } from './titles'

/** Native empty database creation. Historical migration records remain empty. */
export function createRuntimeSchema(sqlite: Database.Database) {
  if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Native initialization requires an empty database')
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Native initialization requires foreign_keys=ON')
  sqlite.transaction(() => {
    for (const statement of runtimeSchemaStatements) sqlite.exec(statement)
    sqlite.exec('CREATE TABLE platform_runtime_capability(transform_version TEXT PRIMARY KEY)')
    for (const capability of runtimeCapabilities) sqlite.prepare('INSERT INTO platform_runtime_capability VALUES(?)').run(capability)
    for (const title of TITLE_SEED) sqlite.prepare('INSERT INTO title(code,name_zh,level,rank) VALUES(?,?,?,?)').run(title.code,title.nameZh,title.level,title.rank)
    for (const namespace of ['query', 'relation']) sqlite.prepare('INSERT INTO platform_legacy_alias_sequence(namespace,high_water) VALUES(?,0)').run(namespace)
    sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)').run(runtimeSchemaHash, 71613)
    sqlite.prepare('INSERT INTO platform_runtime_completion(id,rule,schema_version,completed_at) VALUES(1,?,?,?)').run(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION, new Date().toISOString())
    sqlite.pragma(`user_version=${PLATFORM_RUNTIME_VERSION}`)
    assertApplicationSchema(sqlite)
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Native initialization foreign key conflict')
  }).immediate()
}
