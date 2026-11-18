import {expect,it} from 'vitest'
import * as schema from '../../../db/schema'
import {readPlatformComparisonProcesses} from '../../../layers/sme-roster/server/utils/platform-comparison-input'
import {nativeImportDb} from '../../roster/imports/fixtures/native-import'
it.each([0,999])('rejects unavailable event owner %i without fabricating empty comparison',eventId=>{
 const db=nativeImportDb()
 try{const e=db.insert(schema.enterprise).values({name:'Native boundary',nameNorm:'native boundary'}).returning().get();const before=db.$client.serialize()
 expect(()=>db.$client.transaction(()=>readPlatformComparisonProcesses(db.$client,{enterpriseId:e.id,titleCode:'specialized_sme',eventIds:[eventId],selectedQueryIds:[]}))()).toThrow('platform_comparison_scope_unavailable')
 expect(db.$client.serialize().equals(before)).toBe(true)
 }finally{db.$client.close()}
})
