/** S source-binding helpers copied from the accepted T05a cell/manifest grammar.
 * Earlier upgrade phases retain their existing implementation and receipts. */
import {createHash} from 'node:crypto'
import type Database from 'better-sqlite3'
function columns(s: Database.Database, table: string) {
  return (s.prepare(`pragma table_info("${table}")`).all() as {name:string}[]).map(c => c.name)
}
/** Fixed schema ordinal order, per-cell storage class + SQLite CAST bytes. Evidence-only. */
export function rowSnapshot(s: Database.Database, table: string, key: string, value: number, fields = columns(s,table)) {
  const row = s.prepare(`select ${fields.flatMap((c,i) => [`typeof("${c}") k${i}`,`hex(cast("${c}" as blob)) b${i}`]).join(',')} from "${table}" where "${key}"=?`).get(value) as Record<string,string> | undefined
  if (!row) throw new Error(`Missing source row ${table}:${value}`)
  return fields.map((name,i) => {
    const storageClass=row[`k${i}`]!,hex=row[`b${i}`]!
    if(storageClass!=='real') return {name,storageClass,hex}
    const numeric=s.prepare(`select "${name}" value from "${table}" where "${key}"=?`).get(value) as {value:number}
    const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric.value)
    return {name,storageClass,hex,real64be:bits.toString('hex')}
  })
}

// Complete source identity/assignment/reference domains, not just T04's query manifest.
export const archiveDomains = ['platform_observation_archive_ref','platform_archive_value']
export const observationDomains = [...archiveDomains,'platform_query','platform_query_legacy_provenance','platform_query_title_scope','platform_query_title_scope_error','platform_relation','platform_business_observation','platform_business_record','platform_business_record_version','platform_observation_assignment','platform_apply_projection','platform_business_projection','platform_recognized_projection','enterprise','enterprise_alias','import_batch']
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
export function observationManifest(s: Database.Database, emit?: (line:string) => void) {
  const h = createHash('sha256'), counts: Record<string,number> = {}
  for (const table of observationDomains) {
    const info = s.prepare(`pragma table_info("${table}")`).all() as {name:string,pk:number}[]
    if (!info.length) throw new Error(`Required source domain absent: ${table}`)
    const fields = info.map(c=>c.name)
    const order = info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`"${c.name}"`).join(',')
    if (!order) throw new Error(`No source PK: ${table}`)
    let count = 0
    for (const row of s.prepare(`select ${fields.flatMap((c,i)=>[`typeof("${c}") k${i}`,`hex(cast("${c}" as blob)) b${i}`,`case when typeof("${c}")='real' then "${c}" end n${i}`]).join(',')} from "${table}" ${table==='platform_archive_value'?'where exists (select 1 from platform_observation_archive_ref where archive_id=platform_archive_value.id)':''} order by ${order}`).iterate()) {
      const cells = row as Record<string,string>
      const line = JSON.stringify({table,fields:fields.map((name,i)=>{
        const storageClass=cells[`k${i}`]!,hex=cells[`b${i}`]!,bytes=Buffer.from(hex,'hex')
        const metadata={name,storageClass,hex,byteLength:storageClass==='null'?null:bytes.length,sha256:storageClass==='null'?null:digest(bytes)}
        if(storageClass!=='real') return metadata
        const numeric=(row as Record<string,unknown>)[`n${i}`]
        if(typeof numeric!=='number') throw new Error('Invalid REAL storage')
        const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric)
        return {...metadata,real64be:bits.toString('hex')}
      })})
      h.update(line+'\n'); emit?.(line); count++
    }
    counts[table]=count
  }
  return {digest:h.digest('hex'),counts}
}
export function schemaHash(s: Database.Database) {
  return digest(JSON.stringify(s.prepare("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%' order by type,name").all()))
}
