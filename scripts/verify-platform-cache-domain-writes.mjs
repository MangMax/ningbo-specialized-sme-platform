#!/usr/bin/env node
// Real public write routes against one disposable synthetic SQLite database.
// Reads use two production instances and compare cached REST with uncached MCP.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'

const require = createRequire(import.meta.url)
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb, schema } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'summary-domain-writes-89-'))
const dbPath = join(dir, 'synthetic.sqlite')
const token = 'synthetic-cache-write-token'
const children = []
const checks = []
const telemetry = join(dir, 'cache-telemetry.mjs')
writeFileSync(telemetry, `import {channel} from 'node:diagnostics_channel';let stats=null;
channel('ningbo.platform-summary-cache').subscribe(s=>{stats=s});
process.on('message',m=>{if(m?.op==='stats')process.send?.({op:'stats',stats})});`)

async function start(readOnly) {
  const port = await reserveLoopbackPort()
  const child = fork('.output/server/index.mjs', [], {
    execArgv: ['--max-old-space-size=2048', '--import', telemetry],
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath,
      NUXT_DB_READONLY: readOnly ? '1' : '0', NUXT_PLATFORM_SUMMARY_CACHE: '1',
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: '', NUXT_OCR_TOKEN: '', NUXT_MIIT_COOKIE: '',
      MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
      NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.push(child)
  const base = `http://127.0.0.1:${port}`
  await waitForHttp(`${base}/api/health`, { child, timeoutMs: 30_000 })
  return { base, child }
}

async function stats(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { server.child.off('message', listener); reject(Error('Missing cache telemetry')) }, 5000)
    const listener = message => {
      if (message?.op !== 'stats') return
      clearTimeout(timeout); server.child.off('message', listener); resolve(message.stats)
    }
    server.child.on('message', listener)
    server.child.send({ op: 'stats' })
  })
}

let rpcId = 0
async function summary(server, transport) {
  const response = transport === 'rest'
    ? await fetch(`${server.base}/api/platform/queries?view=summary&page=1&pageSize=25`)
    : await fetch(`${server.base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'list_platform_queries', arguments: { view: 'summary', page: 1, pageSize: 25 } } }),
    })
  assert.equal(response.status, 200, `summary ${transport} HTTP status`)
  assert.equal(response.headers.get('cache-control'), transport === 'mcp' ? 'no-store' : null)
  const raw = await response.text()
  const payload = JSON.parse(raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? raw)
  if (transport === 'rest') return payload
  assert.ok(!payload.error && !payload.result?.isError, 'MCP summary must succeed')
  return JSON.parse(payload.result.content[0].text)
}

async function samePublicResults(servers) {
  const values = []
  for (const server of servers) {
    const rest = await summary(server, 'rest'), mcp = await summary(server, 'mcp')
    assert.deepEqual(rest, mcp, 'REST cache and uncached MCP must agree')
    values.push(rest)
  }
  assert.deepEqual(values[0], values[1], 'both instances must agree')
  return values[0]
}

async function request(server, method, path, body) {
  const response = await fetch(server.base + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value).slice(0, 600)}`)
  return value
}

async function plannedCommit(server, path, body) {
  const preflight = await request(server, 'POST', `${path}/preflight`, body)
  assert.ok(preflight.planHash, `${path} preflight must return planHash`)
  return { commit: () => request(server, 'POST', `${path}/commit`, { request: body, planHash: preflight.planHash }) }
}

try {
  // Fixture setup is direct SQLite only on this disposable database. Every behavior
  // under verification below is written through the app's authenticated REST API.
  const db = useDb({ dbPath })
  const canonical = db.insert(schema.enterprise).values({ name: '合成主体', nameNorm: '合成主体', usccNorm: '91330211255994457P' }).returning().get()
  const duplicate = db.insert(schema.enterprise).values({ name: '合成旧主体', nameNorm: '合成旧主体' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: canonical.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 1, sortKey: 2024 }).returning().get()
  const file = db.insert(schema.storedFile).values({ relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 8, sha256: 'a'.repeat(64), source: 'jxj', kind: 'announcement' }).returning().get()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic notice', path: file.relPath }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, page: 3, listNo: 2 }).run()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: canonical.usccNorm, rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'success' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: canonical.id, usccRaw: canonical.usccNorm, nameRaw: '合成旧名', matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
  const alias = db.insert(schema.enterpriseAlias).values({ enterpriseId: canonical.id, name: '合成旧名', nameNorm: '合成旧名', sourceKind: 'platform_business', sourceRefId: relation.id }).returning().get()
  db.$client.close()

  const writer = await start(false), observer = await start(true), servers = [writer, observer]
  const initial = await samePublicResults(servers)
  assert.equal(initial.total, 1)

  async function verify(label, write, readback, expectedSummary) {
    // Warm the exact cache key after any preflight bookkeeping commit.
    await samePublicResults(servers)
    const before = await Promise.all(servers.map(stats))
    const warmedAt = performance.now()
    const receipt = await write()
    assert.ok(performance.now() - warmedAt < 5000, `${label}: write exceeded cache TTL; invalidation cannot be distinguished from expiry`)
    const result = await samePublicResults(servers)
    if (expectedSummary) expectedSummary(result)
    const after = await Promise.all(servers.map(stats))
    for (let i = 0; i < servers.length; i++) {
      assert.equal(after[i].misses, before[i].misses + 1, `${label}: committed write must cause one cold REST refill in instance ${i}`)
      assert.equal(after[i].entries, 1, `${label}: new committed result retained in instance ${i}`)
    }
    if (readback) await readback(receipt)
    checks.push(label)
    return receipt
  }

  const archive = {
    idempotencyKey: 'synthetic-cache-archive', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/query-archive',
    payload: { platformQueries: [{ interface: 'business_list', queryKey: 'synthetic:archive', rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', status: 'no_record' }] },
  }
  await verify('public_query_archive_commit_invalidates_both_instances', async () => {
    const receipt = await request(writer, 'POST', '/api/roster/import/commit', archive)
    assert.equal(receipt.status, 'committed'); return receipt
  }, null, result => { assert.equal(result.total, 2); assert.equal(result.counts.no_record, 1) })

  const merge = {
    idempotencyKey: 'synthetic-cache-merge', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/merge',
    payload: { merges: [{ fromEnterpriseId: duplicate.id, intoUscc: canonical.usccNorm, aliasName: duplicate.name, sourceKind: 'manual' }] },
  }
  await verify('public_merge_commit_invalidates_both_instances', async () => {
    const receipt = await request(writer, 'POST', '/api/roster/import/commit', merge)
    assert.equal(receipt.status, 'committed'); assert.equal(receipt.items.find(item => item.kind === 'merge')?.ok, true)
    return receipt
  }, async () => {
    const result = await fetch(`${writer.base}/api/roster/enterprises?q=${encodeURIComponent(duplicate.name)}`)
    assert.equal(result.status, 200)
    assert.ok((await result.json()).rows.some(row => row.enterpriseId === canonical.id), 'merged name resolves to canonical enterprise')
  })

  await verify('public_alias_confirm_invalidates_both_instances', async () => {
    const value = await request(writer, 'PATCH', `/api/roster/enterprises/${canonical.id}/aliases/${alias.id}`, {
      action: 'confirm', expectedVersion: 1, actor: 'synthetic-agent', basis: 'synthetic relation checked', idempotencyKey: 'synthetic-cache-alias',
    })
    assert.equal(value.alias.verificationStatus, 'confirmed'); return value
  }, async () => {
    const value = await (await fetch(`${writer.base}/api/roster/enterprises/${canonical.id}/aliases/${alias.id}`)).json()
    assert.equal(value.verificationStatus, 'confirmed')
  })

  const correction = {
    idempotencyKey: 'synthetic-cache-event', sourceIdentity: file.relPath, actor: { type: 'agent', id: 'synthetic-agent' },
    basis: 'Synthetic official source review', operations: [{ eventId: event.id, recordId: record.id, enterpriseId: canonical.id, expectedRevision: 1, patch: { year: 2025, decidedYear: 2025 } }],
  }
  const eventPlan = await plannedCommit(writer, '/api/roster/events/corrections', correction)
  await verify('public_event_correction_commit_invalidates_both_instances', eventPlan.commit, async () => {
    const value = await (await fetch(`${writer.base}/api/roster/events/${event.id}`)).json()
    assert.equal(value.event.year, 2025)
  })

  const exportSnapshot = (key, sha) => ({
    idempotencyKey: key, sourceKind: 'platform_export', sourceIdentity: 'synthetic/export.xlsx',
    payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'export.xlsx', sha256: sha,
      rows: [{ sourceRowNo: 1, usccRaw: canonical.usccNorm, nameRaw: '合成主体', rawFields: { '1': '合成主体' } }] } },
  })
  let firstExportId
  await verify('public_export_archive_commit_invalidates_both_instances', async () => {
    const value = await request(writer, 'POST', '/api/roster/import/commit', exportSnapshot('synthetic-cache-export-a', 'b'.repeat(64)))
    assert.equal(value.status, 'committed')
    return value
  }, async () => {
    const response = await fetch(`${writer.base}/api/roster/record-comparison/sources?kind=export_batch`)
    assert.equal(response.status, 200)
    const catalog = await response.json()
    assert.equal(catalog.total, 1)
    firstExportId = catalog.rows[0].id
    assert.equal(catalog.rows[0].sha256, 'b'.repeat(64))
  })
  await verify('public_export_replacement_commit_invalidates_both_instances', async () => {
    const value = await request(writer, 'POST', '/api/roster/import/commit', exportSnapshot('synthetic-cache-export-b', 'c'.repeat(64)))
    assert.equal(value.status, 'committed'); return value
  }, async () => {
    const response = await fetch(`${writer.base}/api/roster/record-comparison/sources?kind=export_batch`)
    assert.equal(response.status, 200)
    const catalog = await response.json()
    assert.equal(catalog.total, 2)
    assert.ok(catalog.rows.some(row => row.sha256 === 'c'.repeat(64) && row.replacedBatchId === firstExportId))
  })

  const correspondence = {
    idempotencyKey: 'synthetic-cache-correspondence', sourceIdentity: 'synthetic/relation', actor: { type: 'agent', id: 'synthetic-agent' },
    basis: 'Explicit synthetic row review', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }],
  }
  const correspondencePlan = await plannedCommit(writer, '/api/roster/correspondences', correspondence)
  const correspondenceReceipt = await verify('public_correspondence_commit_invalidates_both_instances', correspondencePlan.commit, async value => {
    assert.equal(value.correspondenceIds.length, 1)
    const result = await (await fetch(`${writer.base}/api/roster/correspondences/${value.correspondenceIds[0]}`)).json()
    assert.equal(result.status, 'candidate')
  })
  const correspondenceDecision = { ...correspondence, idempotencyKey: 'synthetic-cache-correspondence-decision',
    operations: [{ action: 'decide', correspondenceId: correspondenceReceipt.correspondenceIds[0], expectedRevision: 1, status: 'rejected' }] }
  const decisionPlan = await plannedCommit(writer, '/api/roster/correspondences', correspondenceDecision)
  await verify('public_correspondence_decision_invalidates_both_instances', decisionPlan.commit, async () => {
    const result = await (await fetch(`${writer.base}/api/roster/correspondences/${correspondenceReceipt.correspondenceIds[0]}`)).json()
    assert.equal(result.status, 'rejected')
  })

  const proof = {
    idempotencyKey: 'synthetic-cache-proof', sourceIdentity: file.relPath, actor: { type: 'agent', id: 'synthetic-agent' },
    basis: 'Reviewed complete synthetic announcement scope', ruleId: 'manual-scope', ruleVersion: '1',
    operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: {
      titleCode: 'specialized_sme', fromYear: 2025, throughYear: 2025, enterpriseIds: null, fullRange: true,
      sourceDocuments: [{ id: doc.id, fileId: file.id, sha256: file.sha256, reference: { field: 'record_evidence.source_file', page: 3, listNo: 2 } }],
    } }],
  }
  const proofPlan = await plannedCommit(writer, '/api/roster/comparison-scope-proofs', proof)
  const proofReceipt = await verify('public_proof_commit_invalidates_both_instances', proofPlan.commit, async value => {
    assert.equal(value.proofIds.length, 1)
    const result = await (await fetch(`${writer.base}/api/roster/comparison-scope-proofs/${value.proofIds[0]}`)).json()
    assert.equal(result.status, 'confirmed')
    assert.equal(result.valid, true)
  })
  const revoke = { ...proof, idempotencyKey: 'synthetic-cache-proof-revoke',
    operations: [{ action: 'decide', proofId: proofReceipt.proofIds[0], expectedRevision: 2, status: 'revoked' }] }
  const revokePlan = await plannedCommit(writer, '/api/roster/comparison-scope-proofs', revoke)
  await verify('public_proof_revocation_invalidates_both_instances', revokePlan.commit, async () => {
    const result = await (await fetch(`${writer.base}/api/roster/comparison-scope-proofs/${proofReceipt.proofIds[0]}`)).json()
    assert.equal(result.status, 'revoked')
    assert.equal(result.valid, false)
  })

  console.log(JSON.stringify({ passed: true, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'),
    lane: 'synthetic SQLite + real production REST writes + two REST/MCP readers', checks,
    cacheStats: await Promise.all(servers.map(stats)), productionChanged: false }))
} finally {
  await Promise.all(children.map(stopOwnedChild))
  rmSync(dir, { recursive: true, force: true })
}
