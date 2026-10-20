import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
it('adds optional qualification without rewriting legacy decisions and migrates idempotently', () => {
  const dir=mkdtempSync(join(tmpdir(),'qualification026-')),folder=resolve('db/migrations'),baseline=join(dir,'baseline'),sqlite=new Database(':memory:')
  try {
    mkdirSync(join(baseline,'meta'),{recursive:true})
    const journal=JSON.parse(readFileSync(join(folder,'meta/_journal.json'),'utf8'))
    const entries=journal.entries.filter((e:any)=>e.idx<=25)
    for(const entry of entries)cpSync(join(folder,entry.tag+'.sql'),join(baseline,entry.tag+'.sql'))
    writeFileSync(join(baseline,'meta/_journal.json'),JSON.stringify({...journal,entries}))
    migrate(drizzle(sqlite),{migrationsFolder:baseline})
    sqlite.prepare("insert into enterprise(id,name,name_norm) values(1,'Legacy','Legacy')").run()
    sqlite.prepare("insert into title(code,name_zh,level,rank) values('specialized_sme','Synthetic','municipal',2)").run()
    sqlite.prepare("insert into difference_reason(id,enterprise_id,title_code,direction,status,verification_status,recorded_at,created_at) values(1,1,'specialized_sme','extra_in_miit','confirmed_reason','confirmed','2026-01-01','2026-01-01')").run()
    const old=sqlite.prepare('select * from difference_reason').get() as any
    migrate(drizzle(sqlite),{migrationsFolder:folder})
    const upgraded=sqlite.prepare('select * from difference_reason').get() as any
    expect(upgraded).toEqual({...old,current_qualification:null})
    const history=sqlite.prepare('select * from __drizzle_migrations').all()
    migrate(drizzle(sqlite),{migrationsFolder:folder})
    expect(sqlite.prepare('select * from __drizzle_migrations').all()).toEqual(history)
    expect(sqlite.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
  } finally {sqlite.close();rmSync(dir,{recursive:true,force:true})}
})
