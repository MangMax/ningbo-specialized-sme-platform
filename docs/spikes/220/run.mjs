// Run from a checkout with its normal dependencies already prepared. No install.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
const helpers=dirname(fileURLToPath(import.meta.url));
const repo=resolve(process.env.SPIKE_REPO || process.cwd());
const out=resolve(process.argv[2] || '/tmp/spec210-220-'+Date.now());
if(existsSync(out)) throw Error('Use a new, nonexistent output directory; preserve earlier failures.');
mkdirSync(out,{recursive:true}); mkdirSync(join(out,'domain-export'));
const runner=join(dirname(createRequire(join(repo,'package.json')).resolve('vitest/package.json')),'vitest.mjs');
const env={...process.env,SPIKE_REPO:repo,SPIKE_OUT:join(out,'domain-export')};
const tsconfig=join(out,'tsconfig.json');
writeFileSync(tsconfig,JSON.stringify({compilerOptions:{target:'ESNext',module:'ESNext',moduleResolution:'Bundler'}}));
const quote=JSON.stringify;
const config=join(out,'probe.config.mts');
const configText=(include)=>`import base from ${quote(join(repo,'vitest.config.ts'))};\nexport default {...base,tsconfig:${quote(tsconfig)},resolve:{...base.resolve,alias:{...base.resolve?.alias,'@repo':${quote(repo)}}},test:{...base.test,include:${JSON.stringify(include)},setupFiles:[${quote(join(repo,'tests/setup.ts'))}]}};\n`;
writeFileSync(config,configText([join(helpers,'domain-probe.test.ts')]));
const core=join(out,'core.config.mts'); writeFileSync(core,configText([join(repo,'tests/record-correspondence-core.test.ts')]));
function run(name,args){
  const result=spawnSync(process.execPath,args,{cwd:repo,env,encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(join(out,name+'.log'),(result.stdout||'')+(result.stderr||''));
  if(result.status!==0) throw Error(`${name} failed: ${result.status}; retained ${out}`);
}
const git=spawnSync('git',['rev-parse','HEAD','HEAD^{tree}'],{cwd:repo,encoding:'utf8'});
writeFileSync(join(out,'baseline.txt'),git.stdout);
run('domain',[runner,'run','--config',config,'--maxWorkers=1']);
run('core',[runner,'run','--config',core,'--maxWorkers=1']);
run('memory',[join(helpers,'memory-probe.mjs'),'run',out]);
console.log(`Evidence retained at ${out}; expected SQL compatibility FAIL is in domain-differential.json, not a passing implementation.`);
