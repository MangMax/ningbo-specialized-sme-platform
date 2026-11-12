/** S offline artifact context. Exclusive ownership/no writers is an operator precondition,
 * not a guarantee provided by hashes, descriptors or this read transaction. */
import Database from 'better-sqlite3'
import {createHash} from 'node:crypto'
import {realpathSync,statSync,openSync,readSync,closeSync,fstatSync,existsSync} from 'node:fs'
import {drizzle} from 'drizzle-orm/better-sqlite3'
import {sql} from 'drizzle-orm'
import * as schema from '../../db/schema'
export type FrozenSource = {path:string,database:Database.Database,fd:number}
const active=new WeakSet<FrozenSource>()
function standalone(path:string) {
 for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size)throw new Error('Standalone fixed snapshot required')
}
export function withFrozenSource<T>(path:string,action:(source:FrozenSource)=>T):T {
 const resolved=realpathSync(path)
 standalone(resolved)
 const fd=openSync(resolved,'r')
 let database:Database.Database|undefined
 try {
  database=new Database(resolved,{readonly:true,fileMustExist:true})
  database.exec('BEGIN')
  database.prepare('SELECT count(*) FROM sqlite_schema').get()
  if(!['delete','truncate','persist'].includes(String(database.pragma('journal_mode',{simple:true}))))throw new Error('Standalone fixed snapshot required; acquire a SQLite backup first')
  if(JSON.stringify(database.pragma('integrity_check'))!==JSON.stringify([{integrity_check:'ok'}]))throw new Error('Snapshot integrity failure')
  const db=drizzle(database,{schema})
  for(const table of [schema.platformQuery,schema.platformRelation]) {
   if(db.select({id:table.id}).from(table).where(sql`typeof(${table.id}) <> 'integer' OR ${table.id} <= 0 OR ${table.id} > ${Number.MAX_SAFE_INTEGER}`).limit(1).get())throw new Error('Unsafe source identity')
  }
  const source=Object.freeze({path:resolved,database,fd})
  active.add(source)
  try {assertFrozenSource(source,resolved);return action(source)}finally{active.delete(source)}
 }finally{try{database?.close()}finally{closeSync(fd)}}
}
export function fileHash(fd:number) {
 const hash=createHash('sha256'),chunk=Buffer.alloc(1024*1024)
 let size:number,offset=0
 while((size=readSync(fd,chunk,0,chunk.length,offset))>0){hash.update(chunk.subarray(0,size));offset+=size}
 return hash.digest('hex')
}
export function assertFrozenSource(source:FrozenSource,path:string) {
 if(!active.has(source)||!source.database.inTransaction)throw new Error('Inactive frozen source')
 const a=fstatSync(source.fd),b=statSync(path)
 if(a.dev!==b.dev||a.ino!==b.ino||source.path!==realpathSync(path))throw new Error('Inactive frozen source identity')
 standalone(source.path)
}
