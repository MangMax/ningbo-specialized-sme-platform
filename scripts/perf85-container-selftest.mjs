#!/usr/bin/env node
// No Docker image is built or started: fake Docker verifies cleanup ordering.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'perf85-container-selftest-'))
const bin = join(scratch, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2),dir=process.env.FAKE_DOCKER_DIR,mode=process.env.FAKE_DOCKER_MODE;
fs.appendFileSync(path.join(dir,'calls.log'),JSON.stringify(a)+'\\n');
const file=n=>path.join(dir,n+'.state.json');
const read=n=>JSON.parse(fs.readFileSync(file(n)));
const save=(n,v)=>fs.writeFileSync(file(n),JSON.stringify(v));
if(a[0]==='image'&&a[1]==='inspect')process.exit(0);
if(a[0]==='create'){
 const name=a[a.indexOf('--name')+1],labels=a.flatMap((x,i)=>x==='--label'?[a[i+1]]:[]);
 const owner=labels.find(x=>x.startsWith('perf85.owner=')).slice('perf85.owner='.length);
 const mount=a.find(x=>x.startsWith('type=bind,src='));
 save(name,{owner,mount:mount.match(/src=([^,]+)/)[1],running:false,exitCode:null});console.log('fake-id');process.exit(0);
}
const name=a.at(-1);
if(a[0]==='inspect'){
 if(!fs.existsSync(file(name)))process.exit(1);
 const s=read(name);
 if(a[1]==='--format'){
  if(a[2].startsWith('{{index .Config.Labels'))console.log(s.owner);
  else console.log(JSON.stringify({id:'fake-id',name:'/'+name,state:{ExitCode:s.exitCode,OOMKilled:false,Running:s.running},limits:{nanoCpus:1000000000,memoryBytes:4294967296,memorySwapBytes:4294967296},labels:{'perf85.owner':s.owner}}));
 }else console.log('exists');
 process.exit(0);
}
if(a[0]==='start'){const s=read(name);s.running=true;save(name,s);console.log('fake-id');process.exit(0)}
if(a[0]==='wait'){
 const s=read(name);s.exitCode=mode==='interrupt'?143:42;s.running=false;save(name,s);
 if(mode==='interrupt')process.kill(process.ppid,'SIGTERM');
 console.log(s.exitCode);process.exit(0);
}
if(a[0]==='stop'){const s=read(name);s.running=false;s.exitCode=143;save(name,s);console.log(name);process.exit(0)}
if(a[0]==='logs'){console.log('{"synthetic":true}');console.error('cpu.max=100000 100000\\nmemory.max=4294967296');process.exit(0)}
if(a[0]==='rm'){fs.rmSync(file(name));console.log(name);process.exit(0)}
throw Error('Unexpected fake Docker command: '+a.join(' '));
`, { mode: 0o755 })

try {
  for (const mode of ['failure', 'interrupt']) {
    const dir = join(scratch, mode)
    mkdirSync(dir)
    const result = spawnSync('bash', ['scripts/perf85-container.sh', dir], { cwd: process.cwd(), env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PERF85_IMAGE: 'fake-parent-image', FAKE_DOCKER_DIR: dir, FAKE_DOCKER_MODE: mode }, encoding: 'utf8', timeout: 60_000 })
    assert.equal(result.signal, null, `${mode}: runner timed out or was externally killed`)
    assert.equal(result.status, mode === 'interrupt' ? 143 : 1, `${mode}: ${result.stderr}`)
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse)
    const verbs = calls.map(call => call[0])
    const inspectAt = calls.findIndex(call => call[0] === 'inspect' && call[1] === '--format' && call[2].startsWith('{"id"'))
    const removeAt = verbs.lastIndexOf('rm')
    assert.ok(inspectAt >= 0 && removeAt > inspectAt, `${mode}: formatted inspect must precede removal; calls=${JSON.stringify(calls)}; stderr=${result.stderr}`)
    assert.equal(readdirSync(dir).filter(name => name.endsWith('.state.json')).length, 0, `${mode}: owned container remains`)
    const metadata = readdirSync(dir).find(name => name.endsWith('.inspect.json'))
    assert.ok(metadata, `${mode}: exit/OOM/limits metadata missing`)
    const state = JSON.parse(readFileSync(join(dir, metadata), 'utf8'))
    assert.equal(state.state.OOMKilled, false)
    assert.equal(state.limits.memoryBytes, 4 * 1024 ** 3)
    assert.ok(readdirSync(dir).some(name => name.endsWith('.stderr.log')), `${mode}: cgroup log missing`)
    assert.match(readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.stderr.log'))), 'utf8'), /cpu.max=100000 100000/)
    const created = calls.find(call => call[0] === 'create')
    assert.equal(created[created.indexOf('--entrypoint') + 1], 'sh')
    assert.equal(created[created.indexOf('--workdir') + 1], '/app')
    const mount = created.find(arg => typeof arg === 'string' && arg.startsWith('type=bind,src='))
    const fixtureDir = mount.match(/src=([^,]+)/)[1]
    assert.equal(existsSync(fixtureDir), false, `${mode}: generated fixture remains`)
  }
  console.log(JSON.stringify({ passed: true, simulated: ['nonzero-exit', 'SIGTERM'], imageBuild: false, containersStarted: false }))
} finally { rmSync(scratch, { recursive: true, force: true }) }
