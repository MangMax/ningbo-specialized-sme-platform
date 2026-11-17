import Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import { upgradeRecognizedQualification } from './recognized-qualification'
const [target, batch = '100', ...extra] = process.argv.slice(2)
if (!target || extra.length) throw new Error('Usage: node upgrade/run-recognized-qualification.mjs OFFLINE_NATIVE_TARGET [BATCH_SIZE=100]')
for (const suffix of ['-wal','-journal']) if (existsSync(target + suffix) && statSync(target + suffix).size) throw new Error('Standalone offline target required')
const s = new Database(target, { fileMustExist: true })
try {
  const result = upgradeRecognizedQualification(s, { batchSize: Number(batch), onUnavailable(id, reason) { process.stdout.write(JSON.stringify({ projectionId: id, reason }) + '\n') } })
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { s.close() }
