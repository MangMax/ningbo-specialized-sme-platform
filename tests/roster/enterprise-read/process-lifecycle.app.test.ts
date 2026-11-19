import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('reaps an idle unreferenced reader before its otherwise idle host exits', () => {
  const root = process.cwd(), req = createRequire(import.meta.url)
  const jiti = createRequire(req.resolve('nuxt/package.json')).resolve('jiti')
  // The outer test must not keep the host loop alive: a pending Promise alone
  // cannot make an unrefed ChildProcess deliver exit (and reap on Linux).
  const host = `import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))});
const {createJiti}=require(${JSON.stringify(jiti)});
const load=createJiti(${JSON.stringify(resolve(root, 'package.json'))});
const {createEnterpriseReadProcess}=await load.import(${JSON.stringify(resolve(root, 'layers/sme-roster/server/utils/enterprise-read-process.ts'))});
const child=createEnterpriseReadProcess(new URL('file:///unused'),"process.send({ready:true});setInterval(()=>{},1000)");
child.once('message',async()=>{child.unref();await child.terminate();await child.terminate();console.log('reader reaped before host exit')});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', host], { encoding: 'utf8', timeout: 10000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('reader reaped before host exit\n')
})
