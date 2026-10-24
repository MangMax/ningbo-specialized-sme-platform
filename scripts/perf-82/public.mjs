// Compiled Nitro HTTP + actual MCP transport; loopback-owned process only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../lib/isolated-local-services.mjs'
const [input, output, workInput, selectorInput] = process.argv.slice(2)
if (!input || !output || !workInput || existsSync(output)) throw new Error('Usage: node public.mjs PRIVATE_DB NEW_OUTPUT_JSONL PRIVATE_DIR')
const work = realpathSync(workInput), dbPath = realpathSync(input)
if (!dbPath.startsWith(work + '/') || dbPath.includes('/production-docker/')) throw new Error('Private copy required')
const entry = new URL('../../.output/server/index.mjs', import.meta.url)
if (!existsSync(entry)) throw new Error('Run pnpm build first')
const db = new Database(dbPath, { readonly: true })
if (selectorInput && !realpathSync(selectorInput).startsWith(work + '/')) throw new Error('Private selector file required')
const key = selectorInput ? JSON.parse(readFileSync(selectorInput, 'utf8')).privateKey : db.prepare('select query_key k from platform_query order by length(raw_response) desc limit 1').get().k
db.close()
const emit = value => appendFileSync(output, JSON.stringify(value) + '\n', { mode: 0o600 })
let expectedDigest
emit({ type: 'environment', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, heapMiB: 2048,
  lane: 'compiled Nitro + actual /mcp JSON-RPC; no SQL phase instrumentation; no container limits', cold: 'fresh process after lightweight health readiness (DB connection initialized)' })
for (const lane of ['HTTP', 'MCP']) for (const concurrency of [1, 2, 5]) {
  const port = await reserveLoopbackPort()
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|COOKIE|PASSWORD|SECRET|^NUXT_|^NITRO_|^PORT$|^HOST$|NODE_OPTIONS/.test(k)))
  const child = fork(fileURLToPath(entry), { silent: true, execArgv: ['--max-old-space-size=2048', '--import', fileURLToPath(new URL('./observe.mjs', import.meta.url))],
    env: { ...env, NODE_OPTIONS: '', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: work + '/empty-files', NUXT_INCOMING_DIR: work + '/empty-incoming', NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', NUXT_IGNORE_LOCK: '1' } })
  let observe
  child.on('message', message => { if (message.type === 'perf82-observation') observe?.(message) })
  child.stdout.on('data', () => {})
  child.stderr.on('data', bytes => appendFileSync(output + '.stderr.private.log', bytes, { mode: 0o600 }))
  const interrupt = () => { child.kill('SIGTERM'); process.exit(130) }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  const base = `http://127.0.0.1:${port}`
  try {
    await waitForHttp(base + '/api/health', { child, timeoutMs: 30000 })
    for (let round = 0; round < 6; round++) {
      const responses = await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
        const start = performance.now()
        const response = await fetch(lane === 'HTTP' ? `${base}/api/platform/queries?queryKey=${encodeURIComponent(key)}` : base + '/mcp', lane === 'HTTP' ? { signal: AbortSignal.timeout(30000) } : {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          body: JSON.stringify({ jsonrpc: '2.0', id: round * 10 + i + 1, method: 'tools/call', params: { name: 'list_platform_queries', arguments: { queryKey: key } } }), signal: AbortSignal.timeout(30000),
        })
        const ttfbMs = performance.now() - start
        const text = await response.text()
        const elapsedMs = performance.now() - start
        const data = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: ')).slice(6) : text)
        const value = lane === 'MCP' ? JSON.parse(data.result?.content?.[0]?.text ?? '{}') : data
        const rpcError = !!data.error || !!data.result?.isError
        if (response.status !== 200 || rpcError || !Array.isArray(value.rows)) throw new Error('Public response failed structural contract')
        const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
        expectedDigest ??= digest
        if (digest !== expectedDigest) throw new Error('HTTP/MCP exact-key result equivalence failed')
        return { status: response.status, rpcError, responseBytes: Buffer.byteLength(text), elapsedMs, ttfbMs, receiveBodyMs: elapsedMs - ttfbMs, returnedRows: value.rows.length, total: value.total, noStore: response.headers.get('cache-control')?.includes('no-store') ?? false }
      }))
      const observation = await Promise.race([new Promise(r => { observe = r; child.send('perf82-observe') }), new Promise(r => setTimeout(() => r(null), 3000))])
      emit({ type: 'public-batch', lane, concurrency, phase: round ? 'hot' : 'cold', round, responses, observation })
    }
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    await stopOwnedChild(child)
  }
}
console.log(JSON.stringify({ output, lane: 'compiled HTTP/MCP', batches: 36 }))
