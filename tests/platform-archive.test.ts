import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createRuntimeSchema } from '../db/create-runtime'
import * as schema from '../db/schema'
import { insertArchiveValue, readArchiveValue, readOwnerArchive, bindArchive, sealArchiveOwner, resolveLegacyReference } from '../lib/platform/immutable-archive'
import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
const connections: Database.Database[] = []
afterEach(() => { for (const s of connections.splice(0)) s.close() })
function fixture() {
  const s = new Database(':memory:'); connections.push(s); s.pragma('foreign_keys=ON'); createRuntimeSchema(s)
  return { s, db: drizzle(s, { schema }) }
}
it.each([null, '', 'null', '{bad', ' \n{"x":"宁波😀"} ', Buffer.from([0, 255, 128])])('retains exact SQLite storage class and bytes: %j', value => {
  const { s, db } = fixture()
  const oracle = s.prepare('select typeof(?) kind,cast(? as blob) bytes').get(value, value) as { kind: 'null'|'text'|'blob'; bytes: Buffer|null }
  const id = insertArchiveValue(db, oracle.kind === 'null' ? { storageClass:'null',bytes:null,createdAt:'original' } : { storageClass:oracle.kind,bytes:oracle.bytes!,createdAt:'original' })
  expect(readArchiveValue(db,{archiveId:id})).toMatchObject({storageClass:oracle.kind,isNull:value===null,totalBytes:oracle.bytes?.length??0,data:(oracle.bytes??Buffer.alloc(0)).toString('base64')})
})
it('rejects every mutation path with recursive triggers disabled or enabled', () => {
  const { s, db } = fixture(), id = insertArchiveValue(db,{storageClass:'blob',bytes:Buffer.from([255]),createdAt:null})
  for(const recursive of [0,1]) {
    s.pragma(`recursive_triggers=${recursive}`)
    for(const statement of [`update platform_archive_value set created_at='changed' where id=${id}`,`delete from platform_archive_value where id=${id}`,`insert or replace into platform_archive_value select * from platform_archive_value where id=${id}`,`insert into platform_archive_value select * from platform_archive_value where id=${id} on conflict(id) do update set created_at='changed'`]) expect(()=>s.exec(statement)).toThrow()
  }
  expect(readArchiveValue(db,{archiveId:id})?.data).toBe('/w==')
})
it('seals native collection owners and rejects foreign identities and namespaces', () => {
  const { db } = fixture()
  const one = submitNativePlatformQuery(db,{interface:'business_list',queryKey:'one',queriedAt:'2026-01-01',status:'success',rawResponse:'one原文',relations:[{sequenceNo:1,relationKey:'one',rawFields:{id:'one'}}]})
  const two = submitNativePlatformQuery(db,{interface:'apply_list',queryKey:'two',queriedAt:'2026-01-01',status:'success',rawResponse:'two'})
  expect(resolveLegacyReference(db,{version:1,kind:'query',queryId:one.queryId})).toEqual({version:2,kind:'collection',collectionId:one.collectionId})
  expect(resolveLegacyReference(db,{version:1,kind:'relation',queryId:one.queryId,relationId:one.relationIds[0]!})).toMatchObject({kind:'observation',collectionId:one.collectionId,observationId:one.observations[0]!.observationId})
  expect(resolveLegacyReference(db,{version:1,kind:'relation',queryId:two.queryId,relationId:one.relationIds[0]!})).toBeNull()
  expect(readOwnerArchive(db,{kind:'collection',ownerId:one.collectionId,field:'rawResponse'})?.data).toBe(Buffer.from('one原文').toString('base64'))
  const archiveId=insertArchiveValue(db,{storageClass:'text',bytes:Buffer.from('replacement'),createdAt:null})
  expect(()=>bindArchive(db,{kind:'collection',ownerId:one.collectionId,field:'rawResponse',archiveId})).toThrow()
  expect(()=>bindArchive(db,{kind:'collection',ownerId:999,field:'rawResponse',archiveId})).toThrow()
})
it('bounds byte slices including split UTF8 and rejects invalid ranges', () => {
  const {db}=fixture(), bytes=Buffer.from('宁波🙂'.repeat(20000)), id=insertArchiveValue(db,{storageClass:'blob',bytes,createdAt:null})
  const read=readArchiveValue(db,{archiveId:id,length:65536})!
  expect(Buffer.from(read.data,'base64')).toEqual(bytes.subarray(0,65536));expect(read.hasMore).toBe(true)
  expect(readArchiveValue(db,{archiveId:id,offset:bytes.length,length:1})).toMatchObject({byteLength:0,hasMore:false})
  for(const range of [{offset:-1},{offset:.5},{length:0},{length:65537}])expect(()=>readArchiveValue(db,{archiveId:id,...range})).toThrow()
})
it('checks independent hashes and rolls back archive inserts inside the caller transaction', () => {
  const {db}=fixture(),bytes=Buffer.from('独立原字节🙂'),sha256=createHash('sha256').update(bytes).digest('hex')
  expect(()=>insertArchiveValue(db,{storageClass:'text',bytes,createdAt:null},{sha256:'0'.repeat(64)})).toThrow()
  expect(()=>db.transaction(tx=>{insertArchiveValue(tx,{storageClass:'text',bytes,createdAt:null},{sha256});throw Error('abort')})()).toThrow('abort')
  expect(db.select().from(schema.platformArchiveValue).all()).toEqual([])
  expect(insertArchiveValue(db,{storageClass:'text',bytes,createdAt:null},{sha256,byteLength:bytes.length})).toBeGreaterThan(0)
})
