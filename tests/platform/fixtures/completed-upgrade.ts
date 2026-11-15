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
 const evidence=join(historical.root,'native-completion');mkdirSync(evidence)
 const target=join(evidence,'native.sqlite')
 completePlatformMigration(historical.legacySource,target,evidence)
 const statements:string[]=[]
 const t=new Database(target,{verbose:q=>statements.push(String(q))});t.pragma('foreign_keys=ON')
 const legacy=new Database(historical.legacySource,{readonly:true})
 return {...historical,target,t,legacy,old:drizzle(legacy,{schema:legacySchema}),db:drizzle(t,{schema}),statements,close(){legacy.close();t.close()}}
}
