/** Acquire a consistent standalone artifact during an operator-owned maintenance window.
 * SQLite backup includes WAL commits. It does not stop application writers. */
import Database from 'better-sqlite3'
import {closeSync,openSync,realpathSync,statSync,statfsSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileHash} from './frozen-source'
import {schemaHash} from '../lib/platform/sqlite-row-cells'
export async function createOfflineSnapshot(sourcePath:string,snapshotPath:string) {
 const source=realpathSync(sourcePath),snapshot=resolve(snapshotPath),identity=statSync(source)
 if(snapshot.trim()!==snapshot)throw new Error('Snapshot path must not have outer whitespace')
 const disk=statfsSync(dirname(snapshot))
 if(disk.bavail*disk.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
 // Exclusive creation also rejects source aliases and existing artifacts, including hardlinks.
 const reserved=openSync(snapshot,'wx');closeSync(reserved)
 const s=new Database(source,{readonly:true,fileMustExist:true})
 try {
  await s.backup(snapshot)
  const now=statSync(source)
  if(identity.dev!==now.dev||identity.ino!==now.ino)throw new Error('Acquisition source identity changed')
 }finally{s.close()}
 const t=new Database(snapshot,{fileMustExist:true})
 try {
  t.pragma('journal_mode=DELETE')
  if(JSON.stringify(t.pragma('integrity_check'))!==JSON.stringify([{integrity_check:'ok'}]))throw new Error('Snapshot integrity failure')
 }finally{t.close()}
 const fd=openSync(snapshot,'r'),check=new Database(snapshot,{readonly:true,fileMustExist:true})
 try {
  return {source,sourceIdentity:{dev:identity.dev,ino:identity.ino},snapshot,snapshotSha256:fileHash(fd),schemaHash:schemaHash(check),userVersion:check.pragma('user_version',{simple:true}),precondition:'operator-maintained-no-writers',method:'sqlite-backup'}
 }finally{check.close();closeSync(fd)}
}
