import type Database from 'better-sqlite3'
import { targetProvenanceCells } from './provenance-cells'

/** Offline capture of the optional source property; runtime never parses the envelope. */
export function captureCollectionPageShape(db:Database.Database) {
  if(db.prepare("SELECT 1 FROM pragma_table_info('platform_collection_page') WHERE name='max_page_present'").get())return
  const capture=()=>{
    db.exec('ALTER TABLE platform_collection_page ADD COLUMN max_page_present INTEGER NOT NULL DEFAULT 0 CHECK(max_page_present IN (0,1))')
    const pages=db.prepare("UPDATE platform_collection_page SET max_page_present=CASE WHEN json_type(json(?),'$.pages['||ordinal||'].maxPage') IS NULL THEN 0 ELSE 1 END WHERE collection_id=?")
    const owners=db.prepare(`SELECT c.id FROM platform_collection c WHERE EXISTS(SELECT 1 FROM platform_collection_page p WHERE p.collection_id=c.id) ORDER BY c.id`).all() as {id:number}[]
    const evidence=db.prepare("SELECT a.bytes,a.storage_class FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='collectionEvidence'")
    for(const owner of owners) {
      const row={...owner,...evidence.get(owner.id) as {bytes:Buffer|null;storage_class:string}}
      let bytes=row.bytes
      if(row.storage_class==='null') {
        const legacy=db.prepare("SELECT a.bytes FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='legacyProvenance'").get(row.id) as {bytes:Buffer}|undefined
        if(legacy) {
          const cell=[...targetProvenanceCells(legacy.bytes)].find(c=>c.name==='collection')
          if(cell&&cell.storageClass!=='null')bytes=Buffer.from(cell.hex,'hex')
        }
      }
      if(!bytes)throw new Error('Page shape requires its original collection evidence')
      pages.run(bytes,row.id)
    }
  }
  if(db.inTransaction)capture();else db.transaction(capture).immediate()
}
