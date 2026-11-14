#!/usr/bin/env node
/** #182 actual built Nuxt public seam + isolated fixture for manual T3 preview.
 * No production paths, migrations or credentials. All business operations use HTTP. */
import assert from 'node:assert/strict'

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { createRuntimeSchema } = await createJiti(import.meta.url).import('../db/create-runtime.ts')
const root = mkdtempSync(join(tmpdir(), 'logs182-public-'))
const business = join(root, 'synthetic.db')
const db = new Database(business)
db.pragma('foreign_keys = ON'); createRuntimeSchema(db)
db.close()
const before = readFileSync(business)
const port = await reserveLoopbackPort(),
  base = `http://127.0.0.1:${port}`
const token = 'fixture-api-182',
  marker = 'PRIVATE182_RAW_NONCE'
const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  NUXT_DB_PATH: business,
  NUXT_DB_READONLY: '1',
  NUXT_LOG_DIR: join(root, 'logs'),
  NUXT_FILES_DIR: join(root, 'files'),
  NUXT_INCOMING_DIR: join(root, 'incoming'),
  NUXT_CURATED_PATH: join(root, 'curated.json'),
  NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
  NUXT_API_TOKEN: token,
  NUXT_MCP_TOKEN: 'fixture-mcp-182',
  NUXT_BROWSER_TASKS_ENABLED: 'true',
  NUXT_OCR_TOKEN: '',
  NUXT_PLATFORM_COOKIE: ''
}
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
child.stdout.on('data', (b) => {
  output += b
})
child.stderr.on('data', (b) => {
  output += b
})
const results = []
const check = (name, fn) => {
  fn()
  results.push({ name, result: 'PASS' })
}
const headers = { authorization: `Bearer ${token}` }
async function request(path, options = {}) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(10000), ...options })
  return { status: r.status, headers: r.headers, body: await r.json() }
}
async function settle(minimum = 1) {
  for (let i = 0; i < 60; i++) {
    const r = await request('/api/logs?limit=100', { headers })
    if (r.status === 200 && r.body.rows.length >= minimum) return r.body
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('real drain readback timed out')
}
const source = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
}
const manifest = { root, base, pid: child.pid, source }
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
async function stop() {
  await stopOwnedChild(child)
  writeFileSync(
    join(root, 'browser-closeout.json'),
    JSON.stringify(
      {
        source,
        businessUnchanged: before.equals(readFileSync(business)),
        outputPrivacy: !output.includes(marker)
      },
      null,
      2
    )
  )
  writeFileSync(join(root, 'server-output.log'), output)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
}
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(0))
})
process.once('SIGINT', () => {
  void stop().then(() => process.exit(0))
})
try {
  await waitForHttp(base + '/api/health', { child })
  for (let i = 0; i < 65; i++)
    await request('/api/health?raw=' + marker, {
      headers: { cookie: marker, 'x-request-id': marker }
    })
  for (let i = 0; i < 5; i++) await request('/api/jobs/not-a-valid-id')
  const all = await settle(70)
  check('actual HTTP → evlog drain → protected summary excludes raw input', () => {
    assert.ok(all.rows.length >= 70)
    assert.ok(!JSON.stringify(all).includes(marker))
    assert.ok(all.rows.some((r) => r.outcome === 'denied'))
  })
  const first = (await request('/api/logs?limit=25', { headers })).body
  await request('/api/health')
  await settle(71)
  const second = (await request('/api/logs?limit=25&cursor=' + first.nextCursor, { headers })).body
  check('append-stable real cursor pages have no overlap', () => {
    assert.equal(first.rows.length, 25)
    assert.equal(second.rows.length, 25)
    assert.equal(second.rows.filter((r) => first.rows.some((a) => a.id === r.id)).length, 0)
  })
  const detail = await request('/api/logs/' + first.rows[0].id, { headers })
  check('real protected detail excludes privacy nonce', () => {
    assert.equal(detail.status, 200)
    assert.equal(detail.body.id, first.rows[0].id)
    assert.ok(!JSON.stringify(detail.body).includes(marker))
  })
  const unauth = await request('/api/logs'),
    browserHeaders = {
      'x-log-browser': '1',
      'sec-fetch-site': 'same-origin',
      referer: base + '/logs'
    }
  const browser = await request('/api/logs', { headers: browserHeaders })
  check('explicit browser capability works while anonymous read is denied', () => {
    assert.equal(unauth.status, 401)
    assert.equal(browser.status, 200)
    assert.equal(browser.headers.get('cache-control'), 'no-store')
  })
  const policy = await request('/api/logs/policy', { headers })
  const changed = await request('/api/logs/policy', {
    method: 'PATCH',
    headers: { ...browserHeaders, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ retentionDays: 6, maxBytes: policy.body.maxBytes })
  })
  const reread = await request('/api/logs/policy', { headers })
  check('actual browser-seam policy persists and reads back', () => {
    assert.equal(changed.status, 200)
    assert.equal(reread.body.retentionDays, 6)
  })
  const refused = await request('/api/logs/clear', {
    method: 'POST',
    headers: { ...browserHeaders, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      confirm: false
    })
  })
  check('actual clear rejects missing confirmation without touching business data', () => {
    assert.equal(refused.status, 400)
    assert.ok(before.equals(readFileSync(business)))
  })
  const page = await fetch(base + '/logs')
  const html = await page.text()
  check('actual Nuxt serves log route without server credentials', () => {
    assert.equal(page.status, 200)
    assert.ok(!html.includes(token))
    assert.ok(!output.includes(marker))
  })
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ manifest, results }, null, 2))
  if (process.argv.includes('--serve')) {
    console.log('Serving isolated fixture; terminate this owned verifier to stop.')
    await new Promise(() => {})
  }
} finally {
  await stop()
}
