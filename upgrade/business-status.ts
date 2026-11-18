import { upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** Explicit new-target prerequisite. Never a startup or completed-target migration. */
import Database from 'better-sqlite3'
import { closeSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../layers/sme-roster/lib/platform/business-status'
import { businessStatusRule, upgradedBusinessStatusDdl } from './business-status-catalog'
import { assertFrozenSource, fileHash, schemaHash, type FrozenSource } from './collections'
import { finalizationCatalog } from './finalize-observations'
import { projectionManifest } from './projections'

const table = 'platform_business_projection'
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const normalize = (sql: string) => sql.replace(/["`]/g, '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase()
const names = z.array(z.object({ name: z.string() }))

export function installBusinessStatusPrerequisite(target: string, frozen: FrozenSource, receiptPath: string, step?: (stage: string) => void) {
  assertFrozenSource(frozen, frozen.path)
  const t = new Database(target, { fileMustExist: true })
  if (t.name === frozen.database.name) { t.close(); throw new Error('Distinct new isolated target required') }
  let receipt: number | undefined
  try {
    t.pragma('foreign_keys=ON')
    receipt = openSync(receiptPath, 'wx', 0o600)
    const result = t.transaction(() => {
      if (t.pragma('user_version', { simple: true }) !== 0 || businessStatusRule(t) !== BUSINESS_STATUS_V1) throw new Error('Fresh expand target required')
      for (const name of ['platform_migration_run', 'platform_migration_checkpoint', 'platform_collection', 'platform_legacy_query_alias', 'platform_legacy_relation_alias']) {
        if (t.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()) throw new Error('Target has begun migration: ' + name)
      }
      for (const name of ['platform_apply_projection', table, 'platform_recognized_projection']) {
        if (t.prepare(`SELECT 1 FROM ${quote(name)} WHERE observation_id IS NOT NULL LIMIT 1`).get()) throw new Error('Observation projection already exists')
      }
      const catalog = finalizationCatalog(t)
      const original = catalog.find(x => x.type === 'table' && x.name === table)
      const migration = readFileSync(new URL('../db/migrations/0052_swift_starhawk.sql', import.meta.url), 'utf8')
      const expected = migration.split('--> statement-breakpoint').map(sql => sql.trim()).find(sql => sql.startsWith('CREATE TABLE "platform_business_projection"'))
      if (!original || !expected || normalize(original.sql) !== normalize(expected)) throw new Error('Unknown expand business catalog')
      for (const item of catalog.filter(x => x.type === 'table')) {
        const incoming = z.array(z.object({ table: z.string() })).parse(t.pragma(`foreign_key_list(${quote(item.name)})`))
        if (incoming.some(f => f.table === table)) throw new Error('Unexpected incoming business projection FK: ' + item.name)
      }
      if (catalog.some(x => x.type === 'view' && x.sql.includes(table))) throw new Error('Unexpected business projection view')
      const affected = catalog.filter(x => x.tbl_name === table || (x.type === 'trigger' && x.sql.includes(table)))
      const installedTriggers = new Map<string, string>()
      for (const file of readdirSync(new URL('../db/migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
        for (const statement of readFileSync(new URL('../db/migrations/' + file, import.meta.url), 'utf8').split('--> statement-breakpoint')) {
          const sql = statement.trim(), create = /^CREATE TRIGGER ["`]?([^"`\s]+)/i.exec(sql), drop = /^DROP TRIGGER ["`]?([^"`\s;]+)/i.exec(sql)
          if (create) installedTriggers.set(create[1]!, sql)
          if (drop) installedTriggers.delete(drop[1]!)
        }
      }
      const expectedTriggers = [...installedTriggers.values()].filter(sql => sql.includes(table))
      const triggers = affected.filter(x => x.type === 'trigger')
      if (!isDeepStrictEqual(triggers.map(x => normalize(x.sql)).sort(), expectedTriggers.map(normalize).sort())) throw new Error('Unknown business projection triggers')
      const sourceSha256 = fileHash(frozen.fd), beforeSchema = schemaHash(t), beforeCells = projectionManifest(t)
      const sequences = t.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers().all()
      for (const trigger of triggers) t.exec(`DROP TRIGGER ${quote(trigger.name)}`)
      t.exec(`CREATE TEMP TABLE status760_cells AS SELECT * FROM ${table}`)
      t.exec(`DROP TABLE ${table}`)
      step?.('dropped')
      t.exec(upgradedBusinessStatusDdl(original.sql))
      step?.('created')
      const columns = names.parse(t.pragma(`table_info(${table})`)).map(x => quote(x.name)).join(',')
      t.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM status760_cells`)
      for (const row of z.array(z.object({ name: z.string(), seq: z.bigint() })).parse(sequences)) {
        if (row.name === table) t.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq, row.name)
      }
      for (const item of affected.filter(x => x.type === 'index' || x.type === 'trigger')) t.exec(item.sql)
      t.exec('DROP TABLE status760_cells')
      step?.('restored')
      const afterCells = projectionManifest(t)
      if (beforeCells !== afterCells || !isDeepStrictEqual(sequences, t.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers().all())) throw new Error('Business prerequisite cell/PK/sequence drift')
      const afterCatalog = finalizationCatalog(t)
      if (!isDeepStrictEqual(catalog.filter(x => x.name !== table), afterCatalog.filter(x => x.name !== table)) || businessStatusRule(t) !== BUSINESS_STATUS_V2) throw new Error('Business prerequisite catalog drift')
      if (!isDeepStrictEqual(upgradeForeignKeyFailures(t), []) || !upgradeIntegrityGate(t)) throw new Error('Business prerequisite integrity failure')
      if (sourceSha256 !== fileHash(frozen.fd)) throw new Error('Frozen source drift')
      const cwd = fileURLToPath(new URL('..', import.meta.url))
      const git = (arg: string) => execFileSync('git', ['rev-parse', arg], { cwd, encoding: 'utf8' }).trim()
      const result = { transform: BUSINESS_STATUS_V2, codeSha: git('HEAD'), codeTree: git('HEAD^{tree}'), sourceSha256, beforeSchema, afterSchema: schemaHash(t), beforeCells, afterCells, sequences: JSON.stringify(sequences, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v) }
      step?.('receipt')
      writeSync(receipt!, JSON.stringify(result, null, 2) + '\n')
      return result
    }).immediate()
    return result
  } catch (error) {
    if (receipt !== undefined) unlinkSync(receiptPath)
    throw error
  } finally {
    if (receipt !== undefined) closeSync(receipt)
    t.close()
  }
}
