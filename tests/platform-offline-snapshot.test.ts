import Database from 'better-sqlite3'
import {it,expect} from 'vitest'
import {mkdtempSync,statSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createOfflineSnapshot} from '../upgrade/offline-snapshot'
it('backs up committed WAL cells into an independent standalone snapshot',async()=>{
 const root=mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR??tmpdir(),'snapshot-'))
 const source=join(root,'source.sqlite'),snapshot=join(root,'snapshot.sqlite')
 const d=new Database(source)
 d.pragma('journal_mode=WAL');d.pragma('wal_autocheckpoint=0')
 d.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY,value);INSERT INTO facts VALUES(1,' pending '),(2,X'00FF'),(3,NULL)")
 expect(statSync(source+'-wal').size).toBeGreaterThan(0)
 const receipt=await createOfflineSnapshot(source,snapshot)
 const s=new Database(snapshot,{readonly:true,fileMustExist:true})
 expect(s.prepare('SELECT id,typeof(value) kind,hex(value) bytes FROM facts ORDER BY id').all()).toEqual([
  {id:1,kind:'text',bytes:'2070656E64696E6720'},{id:2,kind:'blob',bytes:'00FF'},{id:3,kind:'null',bytes:''},
 ])
 expect(s.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
 expect(s.pragma('journal_mode',{simple:true})).toBe('delete')
 expect(receipt.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
 expect(statSync(source).ino).not.toBe(statSync(snapshot).ino)
 const fixed=readFileSync(snapshot);s.close()
 // Acquisition is finished; later changes to original cannot change the artifact.
 d.exec("INSERT INTO facts VALUES(4,'later')");d.close()
 expect(readFileSync(snapshot)).toEqual(fixed)
})
it('rejects missing sources and existing snapshot aliases without overwriting bytes',async()=>{
 const root=mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR??tmpdir(),'snapshot-reject-'))
 const source=join(root,'source.sqlite'),missing=join(root,'missing.sqlite')
 await expect(createOfflineSnapshot(missing,join(root,'out.sqlite'))).rejects.toThrow()
 const d=new Database(source);d.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY)');d.close()
 const before=readFileSync(source)
 await expect(createOfflineSnapshot(source,source)).rejects.toThrow()
 const alias=source+'.alias';linkSync(source,alias)
 await expect(createOfflineSnapshot(source,alias)).rejects.toThrow()
 expect(readFileSync(source)).toEqual(before)
})
import {linkSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
it('snapshot CLI retains a receipt and rejects corrupt SQLite with failure evidence',()=>{
 const root=mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR??tmpdir(),'snapshot-cli-'))
 const source=join(root,'source.sqlite'),snapshot=join(root,'snapshot.sqlite'),evidence=join(root,'receipt')
 const d=new Database(source);d.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY);INSERT INTO facts VALUES(7)");d.close()
 const result=JSON.parse(execFileSync(process.execPath,['upgrade/run-snapshot.mjs',source,snapshot,evidence],{encoding:'utf8'}))
 expect(JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))).toEqual(result)
 expect(result.method).toBe('sqlite-backup')
 const bad=join(root,'bad.sqlite');writeFileSync(bad,'not sqlite')
 const failed=join(root,'failure')
 expect(()=>execFileSync(process.execPath,['upgrade/run-snapshot.mjs',bad,join(root,'bad-copy.sqlite'),failed],{stdio:'pipe'})).toThrow()
 expect(JSON.parse(readFileSync(join(failed,'failure.json'),'utf8')).snapshotUsable).toBe(false)
})
import {writeFileSync} from 'node:fs'
