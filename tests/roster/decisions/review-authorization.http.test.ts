import {afterAll,beforeAll,it,expect} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {currentExport409Fixture} from '../../helpers/current-export-409'
const f=currentExport409Fixture()
beforeAll(()=>f.start(),60000)
afterAll(()=>f.close())
it.each(['difference_snapshot','refresh_enterprise_differences'])('protects %s at HTTP and SDK boundaries',async name=>{
 for(const auth of [undefined,'Bearer incorrect']){
  const response=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(auth?{authorization:auth}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})})
  expect(response.status).toBe(401)
 }
 for(const authorized of [false,true]){
  const client=new Client({name:'final-review',version:'1'})
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL(f.url('/mcp')),{requestInit:{headers:authorized?{authorization:`Bearer ${f.token}`}:{}}}))
   if(!authorized) await expect(client.callTool({name,arguments:{}})).rejects.toThrow(/token-missing/)
   else {
    expect((await client.listTools()).tools.map(t=>t.name)).toContain(name)
    // Invalid input reaches validation, but must not execute a write.
    const result=await client.callTool({name,arguments:name==='refresh_enterprise_differences'?{enterpriseIds:[]}: {}}).catch(error=>error)
    expect(result).toMatchObject({isError:true})
   }
  }finally{await client.close()}
 }
},60000)
