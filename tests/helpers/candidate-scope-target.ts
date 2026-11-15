import { afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdirSync, mkdtempSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { upgradeCollections } from '../../upgrade/collections'
import { upgradeObservations } from '../../upgrade/observations'
import { upgradeProjections } from '../../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../../upgrade/apply-stored'
import { createOfflineSnapshot } from '../../upgrade/offline-snapshot'
export const captureEvidence = process.env.CANDIDATE_SCOPE_EVIDENCE_DIR ?? tmpdir()
const temporaryRoots:string[]=[]
afterAll(()=>{if(!process.env.CANDIDATE_SCOPE_EVIDENCE_DIR)for(const root of temporaryRoots)rmSync(root,{recursive:true,force:true})})
/** Only own synthetic evidence, preserved for validated archive closeout. */
export async function candidateFixture(seed?: (source:Database.Database)=>void, afterStored?: (target:Database.Database)=>void) {
  mkdirSync(captureEvidence,{recursive:true})
  const disk=statfsSync(captureEvidence)
  if(disk.bavail*disk.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
  const root=mkdtempSync(join(captureEvidence,'fixture-')),source=join(root,'legacy.sqlite'),target=join(root,'target.sqlite')
  temporaryRoots.push(root)
  const old=new Database(source)
  try {
    migrate(drizzle(old),{migrationsFolder:'db/migrations'})
    old.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3)")
    seed?.(old)
  } finally {old.close()}
  copyFileSync(source,target)
  const opts={source,target,collectionRunId:'c',observationRunId:'o',projectionRunId:'p',finalizationRunId:'f',batchSize:10}
  upgradeCollections({...opts,runId:'c'});upgradeObservations({...opts,runId:'o'});upgradeProjections({...opts,runId:'p'})
  finalizeObservations({...opts,runId:'f'});finalizeCollectionScopes({...opts,runId:'scopes'})
  const s6=join(root,'71606.sqlite');copyFileSync(target,s6)
  finalizeFingerprintBasis({source:s6,target,runId:'basis',predecessorRunId:'scopes',legacySource:source})
  const s7=join(root,'71607.sqlite');copyFileSync(target,s7)
  finalizeApplyStored({source:s7,target,runId:'stored',predecessorRunId:'basis',legacySource:source})
  if(afterStored){const t=new Database(target);t.pragma('foreign_keys=ON');try{afterStored(t)}finally{t.close()}}
  const snapshot=join(root,'71608.sqlite')
  await createOfflineSnapshot(target,snapshot)
  return {root,source:snapshot,target,runId:'candidate',predecessorRunId:'stored',legacySource:source}
}
