import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { closeSync, constants, copyFileSync, openSync, writeSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { asc, eq, gt } from 'drizzle-orm'
import * as schema from '../db/schema'
import { manifest, upgradeCollections } from './collections'

// No defaults: paths must be supplied, and every write is explicitly an isolated target.
const [command, source, target, evidenceDirectory, runId, batchText] = process.argv.slice(2)
if (command !== 'isolated-upgrade' || !source || !target || !evidenceDirectory || !runId) throw new Error('Usage: node upgrade/run.mjs isolated-upgrade FROZEN_SOURCE NEW_ISOLATED_TARGET EXISTING_EVIDENCE_DIRECTORY RUN_ID [BATCH_SIZE=100]; resume uses same command and existing target')
for (const suffix of ['-wal','-journal']) if (existsSync(source + suffix) && statSync(source + suffix).size > 0) throw new Error('Frozen offline source required')
if (!existsSync(target)) {
  const frozen = new Database(source, { readonly: true, fileMustExist: true })
  try {
    frozen.exec('BEGIN'); frozen.prepare('select count(*) from sqlite_schema').get()
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } finally { frozen.close() }
  const t = new Database(target)
  try { migrate(drizzle(t), { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname }) } finally { t.close() }
}
// Exclusive files preserve all previous raw evidence. Use a new evidence directory on resume.
const fd = openSync(`${evidenceDirectory}/source-manifest.jsonl`, 'wx')
const s = new Database(source, { readonly: true, fileMustExist: true })
try { s.exec('BEGIN'); manifest(s, line => writeSync(fd, line + '\n')) } finally { closeSync(fd); s.close() }
const receipt = upgradeCollections({ source, target, runId, batchSize: Number(batchText ?? 100) })
writeFileSync(`${evidenceDirectory}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
const t = new Database(target, { readonly: true })
const out = openSync(`${evidenceDirectory}/mapping.jsonl`, 'wx')
try {
  const db = drizzle(t, {schema}), q = schema.platformQuery, a = schema.platformLegacyQueryAlias, c = schema.platformCollection, p = schema.platformCollectionPage
  let cursor = 0
  while (true) {
    const rows = db.select({oldId:q.id,collectionId:a.collectionId,provenanceState:c.provenanceState,parseState:c.parseState,status:c.status,evidenceStatus:c.evidenceStatus}).from(q).leftJoin(a,eq(a.oldId,q.id)).leftJoin(c,eq(c.id,a.collectionId)).where(gt(q.id,cursor)).orderBy(asc(q.id)).limit(100).all()
    if (!rows.length) break
    for (const row of rows) {
      const pages = db.select().from(p).where(eq(p.collectionId,row.collectionId ?? -1)).orderBy(asc(p.ordinal)).all()
      writeSync(out,JSON.stringify({...row,pages}) + '\n')
    }
    cursor = rows.at(-1)!.oldId
  }
} finally { closeSync(out); t.close() }
process.stdout.write(JSON.stringify(receipt) + '\n')
