import { afterEach, expect, it, vi } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

let active:ReturnType<typeof nativeCatalogFixture>['db']
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(definition:unknown)=>definition}))
vi.mock('@db',()=>({useDb:()=>active}))
it('native recognized MCP publishes literal source values and read-only annotations',async()=>{
 const f=fixture();active=f.db;f.seed('recognized_list',f.raw('MCP',{rddqrq:'2028/12/31',whpcyear:'2024',whpc:'原批次',private:'PRIVATE-MCP'}))
 const tool=(await import('../../../server/mcp/tools/list_platform_recognized_directory')).default
 expect(tool.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false})
 const result=await tool.handler({rddqrq:'2028/12/31'} as never,{} as never)
 expect(typeof result === 'object' && result !== null && 'structuredContent' in result ? result.structuredContent : undefined).toEqual(f.list('recognized_list',{rddqrq:'2028/12/31'}));expect(JSON.stringify(result)).not.toContain('PRIVATE-MCP')
})
