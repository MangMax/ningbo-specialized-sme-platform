#!/usr/bin/env node
/**
 * #180 运行日志 UI 可用性验证（隔离实例 + 合成 fixture，fixture 不提交）。
 *
 * 目的：给桌面 1280x800 / 窄屏 390x844 的日志页提供可重复的数据面，覆盖：
 * 最长合法 operation(96)、128 位标识、未来安全 httpRoute 模板、全部 outcome、
 * 各 source 的业务对象（fileId/page、batchId、task/artifact、platform、client、
 * system counts）、最长耗时、status 500、旧事件缺失 method/route、失败分支缺 fileId、
 * worker 进程无 taskId。
 *
 * 做法：
 * 1. 在临时目录用 drizzle migrations 克隆一个空的 synthetic 业务库（只读打开）。
 * 2. 直接播种独立日志 SQLite（events.db），事件带 `synthetic: true` 的 fixture 标记；
 *    时间固定在过去 24h 内，页面用 from/to 过滤，避免混入 dev server 自己的请求事件。
 * 3. 端口随机，NUXT_BUILD_DIR 固定在本 worktree 的 .nuxt（保证 native better-sqlite3 解析）。
 * 4. 通过真实 HTTP 读回校验字段，再供宿主 preview 打开。
 *
 * 用法：
 *   node scripts/verify-logs-ui-usability.mjs --serve
 * 退出时写 results.json / manifest.json / closeout.json。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'

const worktree = resolve('.')
const root = mkdtempSync(join(tmpdir(), 'logs-ui-usability-'))
const business = join(root, 'synthetic-business.db')
const logDir = join(root, 'logs')
const apiToken = 'fixture-logs-ui-180'
const longOperation = 'operation.' + 'x'.repeat(86)
const longRoute =
  '/api/organizations/:organizationId/members/:memberId/documents/:documentId/revisions/:revisionId/attachments/:attachmentId/metadata'
const longestId = 'r' + 'q'.repeat(127)
assert.equal(longOperation.length, 96)
assert.ok(longRoute.length <= 160, `route template must fit the 160 contract, got ${longRoute.length}`)
const longErrorCode = 'operation_failed_' + 'x'.repeat(47)
assert.equal(longErrorCode.length, 64)

// —— 1) 合成业务库：只克隆 schema，不写业务数据；fixture 不提交 ——
const businessDb = new Database(business)
migrate(drizzle(businessDb), { migrationsFolder: resolve('db/migrations') })
businessDb.close()
const businessBefore = readFileSync(business)

// —— 2) 播种日志库（与 lib/logging/sqlite-worker.ts 的 schema 一致） ——
const syntheticBase = Date.now() - 24 * 3600 * 1000
let sequence = 0
const at = () => new Date(syntheticBase + sequence++ * 1000).toISOString()
// 一批结构短、同形的正常行，供浏览器在请求闸门下比较骨架与首屏加载后的高度/位置。
const stabilityEvents = Array.from({ length: 30 }, (_, index) => ({
  source: 'task',
  operation: 'task.progress',
  outcome: 'started',
  level: 'info',
  taskId: `task-stability-${index}`,
  counts: { done: index, total: 30 },
  durationMs: 100 + index
}))
const edgeEvents = [
  {
    source: 'http',
    operation: 'http.request',
    outcome: 'success',
    level: 'info',
    httpMethod: 'GET',
    httpRoute: '/api/enterprises/:enterpriseId',
    statusCode: 200,
    durationMs: 18,
    requestId: 'req-http-1',
    traceId: 'trace-http-1'
  },
  {
    source: 'http',
    operation: longOperation,
    outcome: 'failure',
    level: 'error',
    httpMethod: 'POST',
    httpRoute: longRoute,
    statusCode: 500,
    durationMs: Number.MAX_SAFE_INTEGER,
    requestId: longestId,
    traceId: 'trace-long-1',
    errorCode: longErrorCode
  },
  {
    // 旧事件：没有 httpMethod/httpRoute，必须显示「接口未记录」，不能从 resourceId 猜。
    source: 'http',
    operation: 'http.request',
    outcome: 'success',
    level: 'info',
    durationMs: 7,
    requestId: 'req-old-1',
    traceId: 'trace-old-1',
    resourceId: 'file-9',
    resourceType: 'file'
  },
  {
    source: 'http',
    operation: 'http.request',
    outcome: 'denied',
    level: 'warn',
    httpMethod: 'DELETE',
    httpRoute: '/api/files/:id',
    statusCode: 403,
    durationMs: 12,
    requestId: 'req-denied-1'
  },
  {
    source: 'mcp',
    operation: 'mcp.request',
    outcome: 'success',
    level: 'info',
    httpMethod: 'POST',
    httpRoute: '/mcp',
    statusCode: 200,
    durationMs: 35,
    requestId: 'req-mcp-1',
    traceId: 'trace-mcp-1'
  },
  {
    source: 'task',
    operation: 'task.started',
    outcome: 'started',
    level: 'info',
    taskId: 'task-180',
    counts: { done: 0, total: 10 },
    requestId: 'req-task-1'
  },
  {
    source: 'task',
    operation: 'task.finished',
    outcome: 'failure',
    level: 'error',
    taskId: 'task-180',
    counts: { done: 8, total: 10, failed: 2 },
    durationMs: 9000,
    errorCode: 'job_failed',
    requestId: 'req-task-1'
  },
  {
    source: 'task',
    operation: 'task.finished',
    outcome: 'cancelled',
    level: 'info',
    taskId: 'task-181',
    counts: { done: 4, total: 9 }
  },
  {
    source: 'task',
    operation: 'task.recovered',
    outcome: 'unknown',
    level: 'warn',
    taskId: 'task-182',
    errorCode: 'job_interrupted'
  },
  {
    // worker 进程生命周期没有 taskId：目标是「未记录」，关联仍能看到请求。
    source: 'worker',
    operation: 'enterprise_read.process.error',
    outcome: 'failure',
    level: 'error',
    errorCode: 'worker_failed',
    durationMs: 250,
    requestId: 'req-worker-1',
    traceId: 'trace-worker-1'
  },
  {
    source: 'file',
    operation: 'file.render.page',
    outcome: 'success',
    level: 'info',
    fileId: 12,
    page: 3,
    durationMs: 42
  },
  {
    // 失败的 file 事件没有 fileId：不推断，目标未记录，但失败码可见。
    source: 'file',
    operation: 'file.maintenance.update',
    outcome: 'failure',
    level: 'error',
    errorCode: 'file_maintenance_failed',
    durationMs: 61
  },
  {
    // 后台最终 tip 给部分 file 失败分支补了 fileId：有就显示实际文件。
    source: 'file',
    operation: 'file.maintenance.update',
    outcome: 'failure',
    level: 'error',
    fileId: 21,
    errorCode: 'file_maintenance_failed',
    durationMs: 63
  },
  {
    source: 'file',
    operation: 'file.render',
    outcome: 'skipped',
    level: 'info',
    fileId: 12,
    counts: { done: 0, total: 4 }
  },
  {
    source: 'ocr',
    operation: 'ocr.file',
    outcome: 'partial',
    level: 'error',
    fileId: 12,
    counts: { done: 2, total: 3, failed: 1 },
    durationMs: 3200,
    errorCode: 'ocr_file_failed'
  },
  {
    source: 'ocr',
    operation: 'ocr.page',
    outcome: 'timeout',
    level: 'error',
    fileId: 12,
    page: 3,
    durationMs: 30000,
    errorCode: 'ocr_page_timeout'
  },
  {
    source: 'import',
    operation: 'import.execution',
    outcome: 'partial',
    level: 'error',
    batchId: 'batch-180',
    counts: { done: 3, total: 5, failed: 1 }
  },
  {
    source: 'import',
    operation: 'import.execution',
    outcome: 'no_record',
    level: 'warn',
    batchId: 'batch-181',
    errorCode: 'import_outcome_unknown'
  },
  {
    source: 'export',
    operation: 'export.current.publish',
    outcome: 'success',
    level: 'info',
    taskId: 'task-183',
    resourceType: 'export_artifact',
    resourceId: 'job-9',
    counts: { done: 120, total: 120 },
    durationMs: 880
  },
  {
    source: 'platform',
    operation: 'platform.batch.collect',
    outcome: 'partial',
    level: 'warn',
    batchId: 'batch-180',
    taskId: 'batch-180',
    page: 2,
    counts: { done: 1, total: 4, failed: 1 },
    durationMs: 5000
  },
  {
    source: 'mcp',
    operation: 'mcp.request',
    outcome: 'success',
    level: 'info',
    httpMethod: 'POST',
    httpRoute: '/mcp',
    statusCode: 200,
    durationMs: 40,
    requestId: 'req-mcp-init-1',
    origin: { runtime: 'node', integration: 'mcp-toolkit', capture: 'framework', execution: 'request' },
    mcp: {
      transport: 'streamable-http',
      sessionMode: 'stateless',
      rpcMethod: 'initialize',
      client: { name: 'cursor', version: '0.49.1', trust: 'self-reported', capturedAt: 'initialize' },
      protocolVersionRequested: '2025-06-18'
    }
  },
  {
    source: 'mcp',
    operation: 'mcp.tool.get_platform_capabilities',
    outcome: 'success',
    level: 'info',
    httpMethod: 'POST',
    httpRoute: '/mcp',
    statusCode: 200,
    durationMs: 12,
    requestId: 'req-mcp-tool-1',
    // 应用手动埋点只声明确定的 runtime/integration/capture，不从 requestId 推 execution。
    origin: { runtime: 'node', integration: 'application', capture: 'manual' },
    mcp: { transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities' }
  },
  {
    source: 'file',
    operation: 'file.upload',
    outcome: 'success',
    level: 'info',
    statusCode: 204,
    origin: { runtime: 'node', integration: 'tus', capture: 'hook', execution: 'request' },
    tus: { uploadId: '0123456789abcdef0123456789abcdef', phase: 'completed', method: 'PATCH', size: 2048, offset: 2048 }
  },
  {
    source: 'system',
    operation: 'logging.clear',
    outcome: 'success',
    level: 'info',
    counts: { done: 7 }
  },
  {
    source: 'system',
    operation: 'logging.policy',
    outcome: 'success',
    level: 'info'
  },
  {
    // 客户端声称的关联引用：UNTRUSTED，不是 intake requestId。
    source: 'client',
    operation: 'client.tasks.interaction_failure',
    outcome: 'failure',
    level: 'warn',
    requestId: 'intake-180',
    traceId: 'intake-trace-180',
    untrustedRelatedRequestId: 'original-180',
    errorCode: 'interaction'
  },
  {
    // 原生 Drizzle 钩子在执行前：只表示查询尝试，不代表执行成功/失败。
    source: 'system',
    operation: 'db.query.select',
    outcome: 'started',
    level: 'debug',
    resourceType: 'database_connection',
    resourceId: 'primary',
    origin: { runtime: 'node', integration: 'drizzle', capture: 'hook', execution: 'worker' }
  },
  {
    // EmbedPDF 原生日志级别不等于文档加载/渲染结果。
    source: 'client',
    operation: 'client.embedpdf.log_warn',
    outcome: 'unknown',
    level: 'warn',
    origin: { runtime: 'browser', integration: 'embedpdf', capture: 'hook', execution: 'page' }
  },
  {
    // 客户端库信号由服务端固定映射；这些都是浏览器自报，不是服务端执行事实。
    source: 'client',
    operation: 'client.tus.upload_success',
    outcome: 'success',
    level: 'info',
    origin: { runtime: 'browser', integration: 'tus-client', capture: 'hook', execution: 'page' }
  },
  {
    source: 'client',
    operation: 'client.colada.query_failure',
    outcome: 'failure',
    level: 'error',
    origin: { runtime: 'browser', integration: 'pinia-colada', capture: 'hook', execution: 'page' }
  },
  {
    source: 'client',
    operation: 'client.router.navigation_duplicated',
    outcome: 'skipped',
    level: 'debug',
    origin: { runtime: 'browser', integration: 'vue-router', capture: 'hook', execution: 'page' }
  }
]
const events = [...stabilityEvents, ...edgeEvents].map((event) => ({
  id: crypto.randomUUID(),
  timestamp: at(),
  synthetic: true,
  ...event
}))
const outcomeCodes = new Set(events.map((event) => event.outcome))
for (const outcome of ['success', 'failure', 'denied', 'timeout', 'cancelled', 'unknown', 'no_record', 'partial', 'started', 'skipped'])
  assert.ok(outcomeCodes.has(outcome), `fixture must cover outcome ${outcome}`)

mkdirSync(logDir, { recursive: true, mode: 0o700 })
const logDb = new Database(join(logDir, 'events.db'))
logDb.pragma('auto_vacuum = FULL')
logDb.pragma('application_id = 1163283527')
logDb.pragma('journal_mode = DELETE')
logDb.pragma('synchronous = FULL')
logDb.exec('CREATE TABLE log_policy (id INTEGER PRIMARY KEY CHECK(id=1), retentionDays INTEGER NOT NULL, maxBytes INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0)')
logDb.prepare('INSERT INTO log_policy(id,retentionDays,maxBytes) VALUES(1,?,?)').run(7, 512 * 1024 * 1024)
logDb.exec('CREATE TABLE log_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, requestId TEXT, traceId TEXT, taskId TEXT, fileId INTEGER, batchId TEXT, resourceId TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL)')
for (const key of ['timestamp', 'level', 'source', 'operation', 'outcome', 'requestId', 'traceId', 'taskId', 'fileId', 'batchId', 'resourceId'])
  logDb.exec(`CREATE INDEX IF NOT EXISTS log_${key} ON log_events(${key},seq)`)
const insert = logDb.prepare('INSERT INTO log_events(id,timestamp,level,source,operation,outcome,requestId,traceId,taskId,fileId,batchId,resourceId,summary,detail) VALUES(@id,@timestamp,@level,@source,@operation,@outcome,@requestId,@traceId,@taskId,@fileId,@batchId,@resourceId,@summary,@detail)')
logDb.transaction(() => {
  for (const event of events) {
    const { auditId, receiptId, parentEventId, ...summary } = event
    insert.run({
      requestId: null,
      traceId: null,
      taskId: null,
      fileId: null,
      batchId: null,
      resourceId: null,
      ...event,
      batchId: event.batchId === undefined ? null : String(event.batchId),
      resourceId: event.resourceId === undefined ? null : String(event.resourceId),
      summary: JSON.stringify(summary),
      detail: JSON.stringify(event)
    })
  }
})()
logDb.close()

const filterFrom = new Date(syntheticBase - 3600 * 1000).toISOString()
const filterTo = new Date(syntheticBase + 12 * 3600 * 1000).toISOString()
const pagePath = `/logs?from=${encodeURIComponent(filterFrom)}&to=${encodeURIComponent(filterTo)}`

const port = await reserveLoopbackPort()
const base = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(port),
  NUXT_BUILD_DIR: join(worktree, '.nuxt'),
  NUXT_DB_PATH: business,
  NUXT_DB_READONLY: '1',
  NUXT_LOG_DIR: logDir,
  NUXT_FILES_DIR: join(root, 'files'),
  NUXT_INCOMING_DIR: join(root, 'incoming'),
  NUXT_CURATED_PATH: join(root, 'curated.json'),
  NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
  NUXT_API_TOKEN: apiToken,
  NUXT_MCP_TOKEN: 'fixture-mcp-180',
  NUXT_BROWSER_LOGS_ENABLED: 'true',
  NUXT_OCR_TOKEN: '',
  NUXT_PLATFORM_COOKIE: ''
}
const nuxtCli = join(worktree, 'node_modules/nuxt/bin/nuxt.mjs')
const child = spawn(process.execPath, [nuxtCli, 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: worktree,
  stdio: ['ignore', 'pipe', 'pipe'],
  env
})
let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => (output += chunk))
child.stderr.on('data', (chunk) => (output += chunk))

const headers = {
  'x-log-browser': '1',
  'sec-fetch-site': 'same-origin',
  referer: base + '/logs'
}
const syntheticQuery = new URLSearchParams({ from: filterFrom, to: filterTo, limit: '100' }).toString()
async function readSummary() {
  const response = await fetch(`${base}/api/logs?${syntheticQuery}`, {
    headers,
    signal: AbortSignal.timeout(15000)
  })
  assert.equal(response.status, 200, `summary HTTP ${response.status}`)
  return response.json()
}

/** 不猜固定延时：轮询真实日志，直到合并后的请求钩子落下 method + matchedRoute 模板。 */
async function waitForRealHttpEvent(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/logs?limit=100`, {
      headers,
      signal: AbortSignal.timeout(15000)
    })
    assert.equal(response.status, 200, `real-event read HTTP ${response.status}`)
    const body = await response.json()
    const row = body.rows.find(
      (candidate) =>
        !candidate.synthetic &&
        candidate.operation === 'http.request' &&
        candidate.httpRoute === '/api/jobs/:id'
    )
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('real http.request event with matched route template did not appear')
}

/** 真实 200 正常 HTTP 行：给浏览器稳定性检查一个非 synthetic 的普通 HTTP 目标。 */
async function waitForRealHealthEvent(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/logs?limit=100`, {
      headers,
      signal: AbortSignal.timeout(15000)
    })
    assert.equal(response.status, 200, `real-health read HTTP ${response.status}`)
    const body = await response.json()
    const row = body.rows.find(
      (candidate) =>
        !candidate.synthetic &&
        candidate.operation === 'http.request' &&
        candidate.httpRoute === '/api/health' &&
        candidate.statusCode === 200
    )
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('real 200 /api/health event did not appear')
}

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, result: 'PASS' })
  } catch (error) {
    results.push({ name, result: 'FAIL', error: error.message })
    throw error
  }
}
const source = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
}
const manifestExport = process.env.LOGS_UI_MANIFEST_PATH
function writeManifest() {
  const json = JSON.stringify(manifest, null, 2)
  writeFileSync(join(root, 'manifest.json'), json)
  if (manifestExport) writeFileSync(manifestExport, json)
}
const manifest = {
  synthetic: true,
  base,
  pagePath,
  root,
  port,
  pid: child.pid,
  source,
  logDir,
  businessDb: business,
  fixtureEvents: events.length,
  longOperation,
  longestId,
  longRoute,
  longErrorCode
}
writeManifest()

async function stop() {
  await stopOwnedChild(child)
  const businessUnchanged = businessBefore.equals(readFileSync(business))
  writeFileSync(join(root, 'server-output.log'), output)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(
    join(root, 'closeout.json'),
    JSON.stringify({ source, businessUnchanged, outputPrivacy: !output.includes('PRIVATE') }, null, 2)
  )
  return { businessUnchanged }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void stop().then(() => process.exit(0)))

try {
  await waitForHttp(`${base}/api/health`, { child, timeoutMs: 180000 })
  const summary = await readSummary()
  const longRow = summary.rows.find((row) => row.operation === longOperation)
  const detailResponse = await fetch(`${base}/api/logs/${longRow.id}`, {
    headers,
    signal: AbortSignal.timeout(15000)
  })
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json()
  const anonymous = await fetch(`${base}/api/logs?${syntheticQuery}`, {
    signal: AbortSignal.timeout(15000)
  })

  // 真实请求（非 synthetic）：走合并后的请求钩子，证明 method + matchedRoute 确实落库。
  await fetch(`${base}/api/jobs/fixture-real-route-180`, {
    headers: { 'x-fixture': 'real-route-proof' },
    signal: AbortSignal.timeout(15000)
  }).catch(() => {})
  await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15000) }).catch(() => {})
  const realEvent = await waitForRealHttpEvent()
  const realNormalEvent = await waitForRealHealthEvent()

  check('synthetic fixture reads back all rows through the real protected list API', () => {
    assert.equal(summary.rows.length, events.length)
    assert.ok(summary.rows.every((row) => row.synthetic === true))
  })
  check('real server request records method + matched route template, never the concrete path', () => {
    assert.equal(realEvent.httpMethod, 'GET')
    assert.equal(realEvent.httpRoute, '/api/jobs/:id')
    assert.equal(realEvent.operation, 'http.request')
    assert.ok(!realEvent.synthetic)
    assert.ok(realEvent.requestId)
    assert.ok(!JSON.stringify(realEvent).includes('fixture-real-route-180'))
  })
  manifest.realEvent = {
    operation: realEvent.operation,
    httpMethod: realEvent.httpMethod,
    httpRoute: realEvent.httpRoute,
    requestId: realEvent.requestId,
    synthetic: realEvent.synthetic ?? false
  }
  manifest.realNormalEvent = {
    operation: realNormalEvent.operation,
    httpMethod: realNormalEvent.httpMethod,
    httpRoute: realNormalEvent.httpRoute,
    statusCode: realNormalEvent.statusCode,
    requestId: realNormalEvent.requestId,
    synthetic: realNormalEvent.synthetic ?? false
  }
  writeManifest()
  check('real normal HTTP request (200 /api/health) records method + route', () => {
    assert.equal(realNormalEvent.httpMethod, 'GET')
    assert.equal(realNormalEvent.httpRoute, '/api/health')
    assert.equal(realNormalEvent.statusCode, 200)
    assert.ok(!realNormalEvent.synthetic)
  })
  check('http rows expose method + safe route template; old row has neither and is not guessed', () => {
    assert.equal(longRow.httpMethod, 'POST')
    assert.equal(longRow.httpRoute, longRoute)
    assert.equal(longRow.statusCode, 500)
    assert.equal(longRow.durationMs, Number.MAX_SAFE_INTEGER)
    const old = summary.rows.find((row) => row.requestId === 'req-old-1')
    assert.equal(old.httpMethod, undefined)
    assert.equal(old.httpRoute, undefined)
    assert.equal(old.resourceId, 'file-9')
  })
  check('list projection keeps counts and errorCode (merged background contract)', () => {
    const task = summary.rows.find((row) => row.taskId === 'task-180' && row.outcome === 'failure')
    assert.deepEqual(task.counts, { done: 8, total: 10, failed: 2 })
    assert.equal(task.errorCode, 'job_failed')
    const client = summary.rows.find((row) => row.operation === 'client.tasks.interaction_failure')
    assert.equal(client.untrustedRelatedRequestId, 'original-180')
  })
  check('all eleven sources and every outcome are present in the fixture', () => {
    const sources = new Set(summary.rows.map((row) => row.source))
    for (const sourceCode of ['http', 'mcp', 'task', 'worker', 'platform', 'file', 'ocr', 'import', 'export', 'client', 'system'])
      assert.ok(sources.has(sourceCode), `missing source ${sourceCode}`)
    const outcomes = new Set(summary.rows.map((row) => row.outcome))
    for (const outcome of ['started', 'success', 'failure', 'denied', 'timeout', 'cancelled', 'unknown', 'no_record', 'partial', 'skipped'])
      assert.ok(outcomes.has(outcome), `missing outcome ${outcome}`)
  })
  check('origin is optional; application does not infer execution from requestId', () => {
    const mcp = summary.rows.find((row) => row.requestId === 'req-mcp-init-1')
    assert.deepEqual(mcp.origin, {
      runtime: 'node',
      integration: 'mcp-toolkit',
      capture: 'framework',
      execution: 'request'
    })
    const app = summary.rows.find((row) => row.requestId === 'req-mcp-tool-1')
    assert.deepEqual(app.origin, { runtime: 'node', integration: 'application', capture: 'manual' })
    assert.equal('execution' in app.origin, false)
    const tus = summary.rows.find((row) => row.tus?.phase === 'completed')
    assert.deepEqual(tus.origin, {
      runtime: 'node',
      integration: 'tus',
      capture: 'hook',
      execution: 'request'
    })
    const old = summary.rows.find((row) => row.requestId === 'req-old-1')
    assert.equal(old.origin, undefined)
  })
  check('detail is the safe projection with counts/errorCode', () => {
    assert.equal(detail.errorCode, longErrorCode)
    assert.equal(detail.httpMethod, 'POST')
    assert.equal(detail.httpRoute, longRoute)
    assert.ok(detail.synthetic === true)
  })
  check('anonymous read is still denied; only the browser capability can read', () => {
    assert.equal(anonymous.status, 401)
  })
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ manifest, results }, null, 2))
  if (process.argv.includes('--serve')) {
    console.log(`Serving synthetic logs fixture at ${base}${pagePath}`)
    await new Promise(() => {})
  }
} finally {
  const closeout = await stop()
  if (!closeout.businessUnchanged) {
    console.error('business database changed during fixture run')
    process.exitCode = 1
  }
}
