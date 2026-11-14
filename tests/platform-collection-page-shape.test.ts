import Database from 'better-sqlite3'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import { captureCollectionPageShape } from '../upgrade/collection-page-shape'
import { initializeDb } from '../db/client'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import { readDifferenceCollectionScope } from '../lib/platform/difference-sources'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'

it('captures missing, explicit null and numeric maxPage from original archived pages atomically',()=>{
  const db=new Database(':memory:')
  try {
    db.exec(`CREATE TABLE platform_collection(id INTEGER PRIMARY KEY);
      CREATE TABLE platform_collection_page(collection_id INTEGER,ordinal INTEGER,max_page INTEGER);
      CREATE TABLE platform_collection_archive_ref(owner_id INTEGER,field TEXT,archive_id INTEGER);
      CREATE TABLE platform_archive_value(id INTEGER PRIMARY KEY,bytes BLOB,storage_class TEXT);
      INSERT INTO platform_collection VALUES(1);
      INSERT INTO platform_collection_page VALUES(1,0,NULL),(1,1,NULL),(1,2,3);
      INSERT INTO platform_collection_archive_ref VALUES(1,'collectionEvidence',1)`)
    db.prepare('INSERT INTO platform_archive_value VALUES(1,?,?)').run(Buffer.from(JSON.stringify({pages:[{page:1},{page:2,maxPage:null},{page:3,maxPage:3}]})),'text')
    captureCollectionPageShape(db)
    expect(db.prepare('SELECT max_page,max_page_present FROM platform_collection_page ORDER BY ordinal').all()).toEqual([
      {max_page:null,max_page_present:0},{max_page:null,max_page_present:1},{max_page:3,max_page_present:1},
    ])
    captureCollectionPageShape(db)
    expect(db.prepare('SELECT sum(max_page_present) n FROM platform_collection_page').get()).toEqual({n:2})
  }finally{db.close()}
})

it('preserves optional page properties through native target writes and structured reads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'page-shape-')),db=initializeDb({dbPath:join(dir,'native.sqlite'),create:true})
  try {
    for(const [i,extra] of [{},{maxPage:null},{maxPage:1}].entries()) {
      const evidence:PlatformLiveQueryResult={source:'queryBusList',status:'no_record',effectiveConditions:{name:'页元数据'+i,combination:'and'},titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-11-14T00:00:00Z',completedAt:'2026-11-14T00:01:00Z',rows:[],pages:[{source:'queryBusList',rdjb:'2',page:1,...extra,status:'success',fetchedCount:0,declaredTotal:0,error:null}],fetchedCount:0,declaredTotal:0,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
      writeNewCollectionTarget(db,{queryText:JSON.stringify(platformResultToImport(evidence)),evidenceText:JSON.stringify(evidence),createdAt:evidence.completedAt!,assignments:[]})
      const id=(db.$client.prepare('SELECT id FROM platform_collection ORDER BY id DESC LIMIT 1').get() as {id:number}).id
      expect(readDifferenceCollectionScope(db,id).metadata?.pages).toEqual(evidence.pages)
      expect(Object.hasOwn(readDifferenceCollectionScope(db,id).metadata!.pages[0]!,'maxPage')).toBe(i!==0)
    }
  }finally{db.$client.close();rmSync(dir,{recursive:true,force:true})}
})
