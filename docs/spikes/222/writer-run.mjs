// Run only the synthetic writer diagnostic against this checkout's source.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const out = resolve(process.argv[2])
assert.ok(!existsSync(out), 'Output must not exist')
mkdirSync(out, { recursive: true })
const tsconfig = join(out, 'tsconfig.json'), config = join(out, 'probe.config.mts')
writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler' } }))
writeFileSync(config, `import base from ${JSON.stringify(join(repo, 'vitest.config.ts'))};
export default {...base,tsconfig:${JSON.stringify(tsconfig)},test:{...base.test,include:[${JSON.stringify(join(repo, 'docs/spikes/222/writer-probe.test.ts'))}],setupFiles:[${JSON.stringify(join(repo, 'tests/setup.ts'))}]}};`)
const req = createRequire(join(repo, 'package.json'))
const runner = join(dirname(req.resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(process.execPath, [runner, 'run', '--config', config, '--maxWorkers=1'], { cwd: repo, encoding: 'utf8', env: { ...process.env, SPIKE_WRITER_OUT: out } })
writeFileSync(join(out, 'writer.log'), result.stdout + result.stderr)
process.stdout.write(result.stdout); process.stderr.write(result.stderr)
process.exitCode = result.status ?? 1
