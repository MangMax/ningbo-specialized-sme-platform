#!/usr/bin/env node
// Check the private git-archive Docker context without opening a Docker build.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const [mode, directory] = process.argv.slice(2)
assert.ok(['check', 'prepare'].includes(mode) && directory, 'usage: perf85-context.mjs <check|prepare> <private-archive-directory>')
const context = realpathSync(directory)
assert.ok(context.startsWith(realpathSync(tmpdir()) + sep), 'only a private temporary archive context may be changed')
const ignorePath = join(context, '.dockerignore')
const original = readFileSync(ignorePath, 'utf8')
const lines = original.split(/\r?\n/)
const required = ['package.json', 'pnpm-lock.yaml', 'db/migrations', 'scripts/perf85-transport.mjs', 'scripts/perf85-fixture.mjs', 'scripts/lib/isolated-local-services.mjs']
for (const name of required) assert.ok(existsSync(join(context, name)), `archive lacks ${name}`)
const protectedRules = ['/data', '/files', '/businessfiles', '**/*.db', '**/*.sqlite', '**/.env', '*.pem', '*.key', '/tests']
for (const rule of protectedRules) assert.ok(lines.includes(rule), `sensitive or unrelated exclusion missing: ${rule}`)

if (mode === 'prepare') {
  assert.equal(lines.filter(line => line === '/scripts').length, 1, 'expected one root scripts exclusion in archived .dockerignore')
  const updated = lines.filter(line => line !== '/scripts').join('\n')
  assert.deepEqual(updated.split(/\r?\n/), lines.filter(line => line !== '/scripts'), 'only /scripts may change')
  writeFileSync(ignorePath, updated)
  lines.splice(lines.indexOf('/scripts'), 1)
}
assert.ok(!lines.includes('/scripts'), 'Docker would exclude the required scripts/ directory')
assert.ok(!lines.some(line => line === '**/scripts' || line === 'scripts' || line === 'scripts/'), 'another scripts exclusion remains')
console.log(JSON.stringify({ contextReady: true, mode, requiredFiles: required, preservedExclusions: protectedRules, removedExclusion: mode === 'prepare' ? '/scripts' : null }))
