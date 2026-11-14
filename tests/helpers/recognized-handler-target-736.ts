import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { recognizedFixture } from './recognized-target-732'
import { finalizeRecognizedWitness } from '../../upgrade/recognized-witness'
import { finalizeProcessStored } from '../../upgrade/process-stored'
import * as schema from '../../upgrade/legacy-schema'
import { targetSchema } from '../../upgrade/target-schema'

/** Advance the accepted directory fixture through every currently accepted successor. */
export async function recognizedHandlerFixture(extra?: (source: Database.Database) => void) {
  const f = await recognizedFixture(extra)
  f.close()
  const witnessSource = join(f.root, 'witness-source.sqlite')
  copyFileSync(f.target, witnessSource)
  finalizeRecognizedWitness({ source: witnessSource, target: f.target, runId: 'witness', predecessorRunId: 'recognized' })
  const processSource = join(f.root, 'process-source.sqlite')
  copyFileSync(f.target, processSource)
  finalizeProcessStored({ source: processSource, target: f.target, runId: 'process', predecessorRunId: 'witness', legacySource: f.legacySource })
  const t = new Database(f.target)
  t.pragma('foreign_keys=ON')
  const legacy = new Database(f.legacySource, { readonly: true })
  return { ...f, t, legacy, old: drizzle(legacy, { schema }), db: drizzle(t, { schema: targetSchema }), close() { legacy.close(); t.close() } }
}
