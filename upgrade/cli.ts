import { installBusinessStatusPrerequisite } from './business-status'
import { installReconcileSlotPrerequisite, requireReconcileSlotSchema } from './reconcile-slot-schema'
import { RECONCILE_SLOT_T04 } from './frozen/reconcile-slot-capture'
import { completeReconcileSlotCapture } from './reconcile-slot-capture'
import { businessStatusRule } from './business-status-catalog'
import { BUSINESS_STATUS_V2 } from '../layers/sme-roster/lib/platform/business-status'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { closeSync, readSync, openSync, writeSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { asc, eq, gt } from 'drizzle-orm'
import * as schema from './legacy-schema'
import { withFrozenSource, manifest, upgradeCollections } from './collections'

// No defaults: paths must be supplied, and every write is explicitly an isolated target.
const [command, source, target, evidenceDirectory, runId, batchText] = process.argv.slice(2)
if (!['isolated-upgrade','isolated-upgrade-status-blob','isolated-upgrade-reconcile-slot','complete-reconcile-slot'].includes(command ?? '') || !source || !target || !evidenceDirectory || !runId) throw new Error('Usage: node upgrade/run.mjs isolated-upgrade[-status-blob|-reconcile-slot] FROZEN_SOURCE NEW_ISOLATED_TARGET EXISTING_EVIDENCE_DIRECTORY RUN_ID [BATCH_SIZE=100]; or complete-reconcile-slot FROZEN_SCHEMA0 EXISTING_71613 EVIDENCE RUN_ID T04_RUN_ID')
if (command === 'complete-reconcile-slot') {
  if (!batchText) throw new Error('Explicit T04 run required')
  const receipt=completeReconcileSlotCapture({source,target,runId,collectionRunId:batchText})
  writeFileSync(`${evidenceDirectory}/receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stdout.write(JSON.stringify(receipt)+'\n')
} else {
for (const suffix of ['-wal','-journal']) if (existsSync(source + suffix) && statSync(source + suffix).size > 0) throw new Error('Frozen offline source required')
withFrozenSource(source, frozen => {
  if (!existsSync(target)) {
    const destination = openSync(target, 'wx', 0o600), chunk = Buffer.alloc(1024 * 1024)
    try {
      let size: number, offset = 0
      while ((size = readSync(frozen.fd, chunk, 0, chunk.length, offset)) > 0) {
        let written = 0
        while (written < size) written += writeSync(destination, chunk, written, size - written)
        offset += size
      }
    } finally { closeSync(destination) }
    const t = new Database(target)
    try { migrate(drizzle(t), { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname }) } finally { t.close() }
    if (command === 'isolated-upgrade-status-blob' || command === 'isolated-upgrade-reconcile-slot') installBusinessStatusPrerequisite(target, frozen, `${evidenceDirectory}/status-prerequisite.json`)
    if (command === 'isolated-upgrade-reconcile-slot') {
      const receipt=installReconcileSlotPrerequisite(target,frozen)
      writeFileSync(`${evidenceDirectory}/reconcile-prerequisite.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600})
    }
  }
  if (command === 'isolated-upgrade-status-blob' || command === 'isolated-upgrade-reconcile-slot') {
    const installed = new Database(target, { readonly: true })
    try {
      if (businessStatusRule(installed) !== BUSINESS_STATUS_V2) throw new Error('Existing target lacks explicit status prerequisite')
      if (command === 'isolated-upgrade-reconcile-slot') requireReconcileSlotSchema(installed)
    } finally { installed.close() }
  }
  // Exclusive files preserve all previous raw evidence. Use a new evidence directory on resume.
  const fd = openSync(`${evidenceDirectory}/source-manifest.jsonl`, 'wx')
  try { manifest(frozen.database, line => writeSync(fd, line + '\n'),command === 'isolated-upgrade-reconcile-slot') } finally { closeSync(fd) }
  const receipt = upgradeCollections({ source, target, runId, batchSize: Number(batchText ?? 100),transformVersion:command === 'isolated-upgrade-reconcile-slot' ? RECONCILE_SLOT_T04 : undefined }, frozen)
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

})
}
