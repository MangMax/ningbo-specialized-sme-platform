/** Explicit offline fixture owner: preserve the historical source and migrate an isolated copy to retirement. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { completePlatformMigration } from '../../../upgrade/complete-platform'
import * as schema from '../../../db/schema'
import * as legacySchema from '../../../upgrade/legacy-schema'

export function finalEvidenceFixture<T extends {root:string;legacySource:string;close():void}>(historical:T) {
 historical.close()
 return {...historical,...finalEvidenceFromSource(historical.root,historical.legacySource)}
}

export function finalEvidenceFromSource(root:string,legacySource:string) {
 const evidence=join(root,'native-completion');mkdirSync(evidence)
 const target=join(evidence,'native.sqlite')
 completePlatformMigration(legacySource,target,evidence)
 const statements:string[]=[]
 const t=new Database(target,{verbose:q=>statements.push(String(q))});t.pragma('foreign_keys=ON')
 const legacy=new Database(legacySource,{readonly:true})
 return {root,legacySource,target,t,legacy,old:drizzle(legacy,{schema:legacySchema}),db:drizzle(t,{schema}),statements,close(){legacy.close();t.close()}}
}
