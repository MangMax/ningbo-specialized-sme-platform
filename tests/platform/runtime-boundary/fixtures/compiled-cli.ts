/** Upgrade-only subprocess plumbing: compile current CLI closure once per suite. */
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll } from 'vitest'

export function compiledUpgradeCli(entry: 'finalize-observations-cli' | 'fingerprint-basis-cli') {
 const root=mkdtempSync(join(tmpdir(),'upgrade-cli-')),output=join(root,'cli.mjs')
 let ready=false
 beforeAll(async()=>{
  const require=createRequire(import.meta.resolve('nitropack/package.json'))
  const {build}=require('esbuild')
  symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir')
  await build({entryPoints:[resolve('upgrade',entry+'.ts')],outfile:output,bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',plugins:[{
   name:'original-module-urls',setup(build: {onLoad(options:{filter:RegExp},callback:(args:{path:string})=>unknown):void}) {
    build.onLoad({filter:/\.ts$/},({path})=>({contents:readFileSync(path,'utf8').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path).href)),loader:'ts',resolveDir:resolve(path,'..')}))
   },
  }]})
  ready=true
 },30000)
 afterAll(()=>rmSync(root,{recursive:true,force:true}))
 return ()=>{if(!ready)throw new Error('CLI artifact was not prepared');return output}
}
