import { EventEmitter } from 'node:events'

import type { AnyObjectSchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'

import { describe, expect, it } from 'vitest'



import { dirname, join } from 'node:path'

import { fileURLToPath } from 'node:url'

import { installSessionFrontend, inspectPublicSessionPost, isPublicSessionTarget, ownAllRequests, hasNativeSessionOwnership, createSessionRuntime, acceptsSessionFrame, createCredentialSnapshot } from '../../../layers/core/server/utils/mcp-session-runtime'

const finished = () => {
  let resolve!: (receipt: { finished: true }) => void
  return { promise: new Promise<{ finished: true }>(r => { resolve = r }), finish: () => resolve({ finished: true }) }
}

describe('independent runtime literals', () => {
  it('R_native_fixture_reopen_preserves_completion_and_rows', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(join(tmpdir(), '445-native-fixture-'))
    let db: Awaited<ReturnType<typeof fresh445FixtureDB>> | undefined
    try {
      const path = join(directory, 'business.sqlite')
      db = await fresh445FixtureDB(path)
      db.$client.exec("INSERT INTO enterprise(name,name_norm) VALUES('445 fixture','445 fixture')")
      db.$client.close()
      db = await fresh445FixtureDB(path)
      expect(db.$client.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '445 fixture' }])
      expect(db.$client.prepare('SELECT schema_version FROM platform_runtime_completion WHERE id=1').get()).toEqual({ schema_version: 71613 })
      expect(db.$client.prepare("SELECT name FROM sqlite_schema WHERE name IN ('platform_query','platform_relation')").all()).toEqual([])
    } finally {
      if (db?.$client.open) db.$client.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('R_reserved_task_keys_preserve_ordinary_metadata', () => {
    expect(acceptsSessionFrame({ method: 'tools/call', params: { _meta: { ordinary: 'kept' } } })).toBe(true)
    expect(acceptsSessionFrame({ method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'x' } } } })).toBe(false)
    expect(acceptsSessionFrame({ method: 'tools/call', params: { task: {} } })).toBe(false)
    expect(acceptsSessionFrame({ method: 'tasks/get' })).toBe(false)
  })
  it('R_snapshot_is_sticky_and_authorization_only', () => {
    const auth = createCredentialSnapshot('A')
    expect(auth.authenticate(new Headers(), 'A')).toEqual({ kind: 'anonymous', epoch: 0 })
    expect(auth.authenticate(new Headers({ authorization: 'Bearer A' }), 'A')).toEqual({ kind: 'authorized', principal: 'mcp-token', epoch: 0 })
    expect(auth.authenticate(new Headers({ authorization: 'Bearer A', 'x-mcp-token': '' }), 'A')).toEqual({ kind: 'invalid' })
    expect(auth.authenticate(new Headers(), 'B')).toEqual({ kind: 'invalid' })
    expect(auth.authenticate(new Headers(), 'A')).toEqual({ kind: 'invalid' })
  })
  it('R_cancelled_thunk_waits_for_complete_settlement_without_send', async () => {
    const runtime = createSessionRuntime()
    const protocol = {}, event = {}, response = finished()
    runtime.claim(protocol, () => event, 'sid-A')
    const receipt = runtime.reserve(protocol, event, 'sid-A', 1, 'tools/call', response.promise)
    let release!: (value: string) => void
    const result = runtime.observe(protocol, { id: 1, method: 'tools/call' }, { sessionId: 'sid-A' }, () => new Promise<string>(r => { release = r }))
    expect(runtime.snapshot()).toEqual({ owners: 1, requests: 1, poisoned: false })
    release('original-result')
    expect(await result).toBe('original-result')
    expect(await receipt).toEqual({ finished: true })
    expect(runtime.snapshot().requests).toBe(1)
    response.finish()
    await Promise.resolve()
    expect(runtime.snapshot().requests).toBe(0)
    runtime.release(protocol)
  })
  it('R_foreign_owner_transparent_and_observer_failure_retains_charge', async () => {
    const runtime = createSessionRuntime()
    const foreign = new Error('local-control')
    expect(() => runtime.observe({}, { id: 1 }, {}, () => { throw foreign })).toThrow(foreign)
    const owner = {}, event = {}, response = finished()
    runtime.claim(owner, () => { throw new Error('observer fault') }, 'owned')
    void runtime.reserve(owner, event, 'owned', '1', 'ping', response.promise)
    expect(runtime.observe(owner, { id: '1', method: 'ping' }, { sessionId: 'owned' }, () => 7)).toBe(7)
    expect(runtime.snapshot().poisoned).toBe(true)
    response.finish()
    await Promise.resolve()
    expect(runtime.snapshot().requests).toBe(1)
  })
})

describe('445 SDK controls', () => {
  it('C_public_SDK_import_and_initialize_listTools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
    const server = new Server({ name: '445-control', version: '1' }, { capabilities: { tools: {} } })
    const client = new Client({ name: '445-client', version: '1' })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'local_probe', inputSchema: { type: 'object' as const } }] }))
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(a); await client.connect(b)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['local_probe'])
    } finally { await client.close(); await server.close() }
  })
  it('C_public_SDK_notification_aborts_real_extra_signal', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { CallToolRequestSchema, CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js')
    const server = new Server({ name: '445-cancel-control', version: '1' }, { capabilities: { tools: {} } })
    const client = new Client({ name: '445-client', version: '1' })
    let entered!: () => void, released!: () => void, aborted!: () => void, ended!: () => void
    const entry = new Promise<void>(r => { entered = r })
    const gate = new Promise<void>(r => { released = r })
    const abort = new Promise<void>(r => { aborted = r })
    const end = new Promise<void>(r => { ended = r })
    let observed = false
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      const listener = () => { observed = extra.signal.aborted; aborted() }
      extra.signal.addEventListener('abort', listener, { once: true })
      entered()
      try { await gate; return { content: [] } }
      finally { extra.signal.removeEventListener('abort', listener); ended() }
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const controller = new AbortController()
    let replyCount = 0
    const send = a.send.bind(a)
    a.send = async (...args: Parameters<typeof a.send>) => {
      const frame = args[0]
      if ('id' in frame && ('result' in frame || 'error' in frame) && frame.id !== 0) replyCount++
      return send(...args)
    }
    let request: Promise<unknown> | undefined
    try {
      await server.connect(a); await client.connect(b)
      request = client.request({ method: 'tools/call', params: { name: 'local_probe' } }, CallToolResultSchema, { signal: controller.signal, timeout: 2000 })
      const rejection = request.then(() => 'unexpected-success', () => 'rejected')
      await entry
      expect(observed).toBe(false)
      controller.abort()
      await abort
      expect(observed).toBe(true)
      released(); await end
      expect(await rejection).toBe('rejected')
      // Predeclared RED: send-only cannot acknowledge a cancelled, settled handler.
      // Only admissible after the identical real-SDK control passed in C.
      expect(replyCount).toBe(0)
    } finally { released(); await request?.catch(() => {}); await client.close(); await server.close() }
  })
})

describe('bridge helper negatives', () => {
  it('N_failed_late_unknown_does_not_resolve_receipt', async () => {
    const runtime = createSessionRuntime(), owner = {}, event = {}
    runtime.claim(owner, () => event, 'owned')
    let fail!: () => void
    const response = new Promise<{ finished: true }>((_r, reject) => { fail = () => reject(new Error('closed without receipt')) })
    let resolved = false
    void runtime.reserve(owner, event, 'owned', 1, 'unknown', response).then(() => { resolved = true })
    fail(); await Promise.resolve()
    runtime.unknownResponse(owner, 'owned', { id: 1, error: { code: -32601 } })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(runtime.snapshot()).toEqual({ owners: 1, requests: 1, poisoned: true })
  })
  it('N_typed_ids_and_same_sid_distinct_owners_do_not_alias', async () => {
    const runtime = createSessionRuntime(), a = {}, b = {}, ea = {}, eb = {}, response = finished()
    runtime.claim(a, () => ea, 'same-sid'); runtime.claim(b, () => eb, 'same-sid')
    const one = runtime.reserve(a, ea, 'same-sid', 1, 'ping', response.promise)
    const stringOne = runtime.reserve(a, ea, 'same-sid', '1', 'ping', response.promise)
    const other = runtime.reserve(b, eb, 'same-sid', 1, 'ping', response.promise)
    runtime.observe(a, { id: 1, method: 'ping' }, { sessionId: 'same-sid' }, () => 'a')
    expect(await one).toEqual({ finished: true })
    expect(runtime.snapshot().requests).toBe(3)
    runtime.observe(a, { id: '1', method: 'ping' }, { sessionId: 'same-sid' }, () => 'string')
    runtime.observe(b, { id: 1, method: 'ping' }, { sessionId: 'same-sid' }, () => 'b')
    expect(await stringOne).toEqual({ finished: true }); expect(await other).toEqual({ finished: true })
    response.finish(); await Promise.resolve()
    expect(runtime.snapshot().requests).toBe(0)
  })
  it('N_no_sid_cannot_claim_and_retire_waits_for_both_edges', async () => {
    const runtime = createSessionRuntime(), owner = {}, event = {}, response = finished()
    expect(() => runtime.claim(owner, () => event, '')).toThrow('runtime_owner_unavailable')
    let released = 0
    runtime.claim(owner, () => event, 'owned', () => { released++ })
    void runtime.reserve(owner, event, 'owned', 1, 'ping', response.promise)
    runtime.retire(owner)
    expect(released).toBe(0)
    runtime.observe(owner, { id: 1, method: 'ping' }, { sessionId: 'owned' }, () => ({}))
    expect(released).toBe(0)
    response.finish(); await Promise.resolve()
    expect(released).toBe(1)
    expect(runtime.observe(owner, { id: 1 }, {}, () => 'foreign-after-close')).toBe('foreign-after-close')
    expect(runtime.snapshot()).toEqual({ owners: 0, requests: 0, poisoned: false })
  })
})

async function fresh445FixtureDB(dbPath: string) {
  const { initializeDb } = await import('../../../db/client')
  return initializeDb({ dbPath, create: true })
}

async function refusal445NativeResponse() {
  const { EventEmitter } = await import('node:events')
  const events: string[] = [], headers = new Map<string, string>()
  class ResponseDouble extends EventEmitter {
    closed = false; writableEnded = false; writableFinished = false; statusCode = 0
    bytes = Buffer.alloc(0)
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), String(value)) }
    end(bytes: Uint8Array) { events.push('native-end'); this.bytes = Buffer.from(bytes); this.writableEnded = true }
    finish() { this.writableFinished = true; events.push('native-finish'); this.emit('finish') }
    close() { this.closed = true; events.push('native-close'); this.emit('close') }
  }
  return { res: new ResponseDouble(), events, headers }
}

describe('445 early refusal literals', () => {
  it('L_exact_JSON_native_end_precedes_termination_for_each_early_exit', async () => {
    const { createResponseTermination, queueSessionResponse } = await import('../../../layers/core/server/utils/mcp-session-runtime')
    for (const [code, status] of [['session_binding_unavailable', 503], ['body_capacity', 503], ['invalid_identity', 401]] as const) {
      const { res, events, headers } = await refusal445NativeResponse()
      const terminate = createResponseTermination(res, () => { events.push('original-owner-terminate') })
      const foreignFinish = () => { events.push('foreign-listener') }
      res.on('finish', foreignFinish)
      terminate(); terminate()
      expect(events).toEqual([])
      const literal = { jsonrpc: '2.0', id: null, error: { code: -32000, message: code } }
      const response = new Response(JSON.stringify(literal), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      await queueSessionResponse({ node: { res } }, response)
      expect(res.statusCode).toBe(status)
      expect(JSON.parse(res.bytes.toString('utf8'))).toEqual(literal)
      expect(headers.get('content-length')).toBe(String(res.bytes.byteLength))
      expect(headers.has('connection')).toBe(false)
      expect(events).toEqual(['native-end']) // writableEnded is NOT finish.
      expect(res.listenerCount('close')).toBe(1)
      res.finish()
      expect(events).toEqual(['native-end', 'native-finish', 'foreign-listener', 'original-owner-terminate'])
      expect(res.listenerCount('finish')).toBe(1); expect(res.listenerCount('close')).toBe(0)
      terminate(); res.close()
      expect(events.filter(value => value === 'original-owner-terminate')).toHaveLength(1)
    }
  })
  it('L_closed_sync_and_unfinished_close_remove_only_owned_observers', async () => {
    const { createResponseTermination } = await import('../../../layers/core/server/utils/mcp-session-runtime')
    for (const already of [false, true]) {
      const { res } = await refusal445NativeResponse()
      let calls = 0
      const foreign = () => {}
      res.on('close', foreign)
      if (already) res.closed = true
      const terminate = createResponseTermination(res, () => { calls++ })
      terminate()
      expect(calls).toBe(already ? 1 : 0)
      if (!already) { expect(res.writableFinished).toBe(false); res.close() }
      expect(calls).toBe(1); expect(res.writableFinished).toBe(false)
      expect(res.listenerCount('close')).toBe(1); expect(res.listenerCount('finish')).toBe(0)
      terminate(); expect(calls).toBe(1)
    }
  })
  it('L_real_socket_ownership_rechecks_prior_and_late_foreign_after_finish', async () => {
    const { createResponseTermination } = await import('../../../layers/core/server/utils/mcp-session-runtime')
    const { createSocketOwnership } = await import('../../../layers/core/server/utils/mcp-session-transport')
    const ownership = createSocketOwnership<object>(), socket = {}
    let destroyed = 0, closed = false
    const rejected = ownership.register(socket, () => { destroyed++ })
    const prior = ownership.register(socket, () => { throw new Error('foreign destroy selected') })
    void rejected.closed.then(() => { closed = true })
    const { res } = await refusal445NativeResponse()
    // Original native listener records the real response edge before the gate.
    res.once('finish', () => rejected.responseFinished())
    const terminate = createResponseTermination(res, rejected.terminate)
    terminate(); expect(destroyed).toBe(0)
    res.finish()
    const later = ownership.register(socket, () => { throw new Error('late foreign destroy selected') })
    await Promise.resolve(); expect(destroyed).toBe(0)
    prior.requestFinished(); prior.responseFinished()
    await Promise.resolve(); expect(destroyed).toBe(0)
    later.requestFinished(); later.responseFinished()
    await Promise.resolve(); expect(destroyed).toBe(1); expect(closed).toBe(false)
    ownership.closed(socket); await Promise.resolve(); expect(closed).toBe(true)
  })
  it('L_real_S1_rejected_body_remains_charged_until_actual_close_after_JSON', async () => {
    const { createResponseTermination, queueSessionResponse } = await import('../../../layers/core/server/utils/mcp-session-runtime')
    const { createSocketOwnership, createSessionInitializationTransport } = await import('../../../layers/core/server/utils/mcp-session-transport')
    const ownership = createSocketOwnership<object>(), socket = {}
    let destroyed = 0
    const handle = ownership.register(socket, () => { destroyed++ })
    const { res } = await refusal445NativeResponse()
    res.once('finish', () => handle.responseFinished())
    const terminate = createResponseTermination(res, handle.terminate)
    const timers: { callback: () => void; delay: number }[] = []
    const adapter = createSessionInitializationTransport({
      clock: { setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer }, clearTimeout() {} },
      authenticate: () => ({ kind: 'invalid' as const }),
      replay: async () => { throw new Error('unexpected replay') },
      factory: () => { throw new Error('unexpected owner') },
      provider: async () => { throw new Error('unexpected provider') },
      adopted: () => undefined,
      cleanupSession: async () => { throw new Error('unexpected storage') },
    })
    const response = adapter.handle({}, { method: 'POST', url: 'http://445-owned.invalid/mcp-session',
      headers: new Headers({ 'content-length': '1' }), rawHeaders: [['Content-Length', '1'], ['Content-Length', '1']],
      get body(): never { throw new Error('invalid framing must not read body') }, closed: handle.closed, terminate,
    })
    await Promise.resolve()
    expect(timers.map(timer => timer.delay)).toEqual([250])
    expect(adapter.bodySnapshot()).toEqual({ reading: 0, closing: 1, total: 1 })
    expect(destroyed).toBe(0)
    timers[0]!.callback()
    const failure = await response
    expect(failure.status).toBe(400)
    await queueSessionResponse({ node: { res } }, failure)
    expect(JSON.parse(res.bytes.toString('utf8')).error).toMatchObject({ code: -32000, message: 'invalid_framing' })
    expect(adapter.bodySnapshot().total).toBe(1)
    res.finish(); await Promise.resolve()
    expect(destroyed).toBe(1); expect(adapter.bodySnapshot().total).toBe(1)
    ownership.closed(socket); await Promise.resolve(); await Promise.resolve()
    expect(adapter.bodySnapshot()).toEqual({ reading: 0, closing: 0, total: 0 })
    expect(adapter.shutdown().complete).toBe(true)
  })
})

const FRONT445_MOUNT = { baseURL: '/', route: '/mcp-session' as const }

class Front445Socket extends EventEmitter {
  closed = false; destroys = 0
  destroy() { this.destroys++; this.closed = true; this.emit('close') }
}

function front445Pair(socket = new Front445Socket(), target = '/mcp-session', method = 'POST', rawHeaders: string[] = []) {
  const req = Object.assign(new EventEmitter(), { socket, url: target, originalUrl: target, method, rawHeaders, readableEnded: false, closed: false })
  const headers: Record<string, unknown> = {}
  const res = Object.assign(new EventEmitter(), { closed: false, writableEnded: false, writableFinished: false, statusCode: 200, bytes: Buffer.alloc(0) as Buffer<ArrayBufferLike>,
    setHeader(name: string, value: unknown) { headers[name] = value },
    end(bytes: Buffer) { this.bytes = bytes; this.writableEnded = true },
    finish(this: EventEmitter & { writableFinished: boolean }) { this.writableFinished = true; this.emit('finish') },
  })
  return { req, res, headers, socket, endRequest() { req.readableEnded = true; req.emit('end') } }
}

function front445App() {
  return { options: {}, stack: [] as any[], use(layer: any) { this.stack.push(layer); return this } }
}

function front445Server() {
  const app = front445App(), entered: string[] = []
  let published = false
  const server = new EventEmitter()
  const original = function (this: unknown, req: any, res: any) {
    expect(this).toBe(server); entered.push(req.url)
    if (!published) return // CLI-owned loading response remains active.
    for (const layer of app.stack) if (layer.match(req.url, { node: { req, res } })) layer.handler({ node: { req, res } })
  }
  server.on('request', original)
  return { app, server, original, entered, publish() { published = true } }
}

describe('445 public frontend literals', () => {
  it('H_exact_limits_invalid_headers_and_no_body_read', () => {
    const check = (headers: string[], method = 'POST', target = '/mcp-session') => inspectPublicSessionPost(method, target, headers, FRONT445_MOUNT)
    for (const value of ['0', '1', '16384']) expect(check(['Content-Length', value])).toEqual({ kind: 'pass' })
    expect(check(['Content-Length', '16385'])).toEqual({ kind: 'reject', status: 413, code: 'body_too_large' })
    expect(check(['MCP-Session-ID', '', 'Content-Length', '65536'])).toEqual({ kind: 'pass' })
    expect(check(['MCP-Session-ID', 'opaque', 'Content-Length', '65537'])).toEqual({ kind: 'reject', status: 413, code: 'body_too_large' })
    for (const headers of [[], ['Content-Length', '01'], ['Content-Length', '-1'], ['Content-Length', '1.0'], ['Content-Length', '9007199254740992'], ['Content-Length', '1', 'content-length', '1'], ['Content-Length', '1', 'Transfer-Encoding', 'chunked'], ['Content-Length', '1', 'Content-Encoding', 'identity'], ['Content-Length', '1', 'Content-Encoding', 'gzip']]) {
      expect(check(headers)).toEqual({ kind: 'reject', status: 400, code: 'invalid_framing' })
    }
    expect(check(['Authorization', 'Bearer invalid', 'Content-Length', '1'])).toEqual({ kind: 'pass' }) // Worker auth follows legal public framing.
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) expect(check([], method)).toEqual({ kind: 'pass' })
    expect(check([], 'POST', '/mcp')).toEqual({ kind: 'pass' })
  })
  it('S_H3_selector_query_trailing_encoding_baseURL_and_old_route', () => {
    for (const target of ['/mcp-session', '/mcp-session/', '/mcp-session?x=%2F', '/%6dcp-session']) expect(isPublicSessionTarget(target, FRONT445_MOUNT)).toBe(true)
    for (const target of ['/mcp', '/mcp-session//', '//mcp-session', '/%2fmcp-session', '/mcp%2fsession', '/%256dcp-session', '/mcp-session%ZZ', 'http://host/mcp-session', '/mcp-session/../mcp-session']) expect(isPublicSessionTarget(target, FRONT445_MOUNT)).toBe(false)
    const mount = { baseURL: '/tenant/', route: '/mcp-session' as const }
    for (const target of ['/tenant/mcp-session', '/tenant/mcp-session/?x=1', '/%74enant/mcp-session']) expect(isPublicSessionTarget(target, mount)).toBe(true)
    for (const target of ['/mcp-session', '/tenant/mcp', '/tenant//mcp-session']) expect(isPublicSessionTarget(target, mount)).toBe(false)
  })
  it('I_single_listener_reload_unknown_shape_and_source_ready_axis', () => {
    const f = front445Server(), binding = installSessionFrontend(f.server, FRONT445_MOUNT, 'literal-v1', true)
    expect(binding.installed).toBe(true); expect(binding.ready()).toBe(false)
    const initial = front445Pair(); f.server.emit('request', initial.req, initial.res)
    expect(initial.res.statusCode).toBe(503); expect(JSON.parse(initial.res.bytes.toString()).error.data.code).toBe('session_binding_unavailable')
    expect(binding.bindApp(f.app, handler => handler)).toBe(true); expect(binding.ready()).toBe(true)
    const wrapped = f.server.rawListeners('request')[0]
    expect(installSessionFrontend(f.server, FRONT445_MOUNT, 'literal-v1', true)).toBe(binding)
    expect(binding.ready()).toBe(false)
    expect(binding.bindApp(f.app, handler => handler)).toBe(true); expect(f.app.stack).toHaveLength(1)
    expect(f.server.rawListeners('request')).toEqual([wrapped])
    const replacement = front445App(); expect(binding.bindApp(replacement, handler => handler)).toBe(true)
    replacement.stack.unshift({}); expect(binding.ready()).toBe(false)
    const displaced = front445Pair(); f.server.emit('request', displaced.req, displaced.res); expect(displaced.res.statusCode).toBe(503)
    const many = new EventEmitter(), first = () => {}, second = () => {}; many.on('request', first); many.on('request', second)
    expect(installSessionFrontend(many, FRONT445_MOUNT, 'literal-v1', true).installed).toBe(false)
    expect(many.rawListeners('request')).toEqual([first, second])
    const unpinned = front445Server(); expect(installSessionFrontend(unpinned.server, FRONT445_MOUNT, 'literal-v1', false).installed).toBe(false); expect(unpinned.server.rawListeners('request')).toEqual([unpinned.original])
    expect(binding.bindApp({ options: { onRequest() {} }, stack: [], use() {} }, handler => handler)).toBe(false); expect(binding.ready()).toBe(false)
    expect(binding.bindApp(replacement, handler => handler)).toBe(false) // displaced layer cannot be silently re-adopted.
    const once = new EventEmitter(); once.once('request', first); const onceBefore = once.rawListeners('request')
    expect(installSessionFrontend(once, FRONT445_MOUNT, 'literal-v1', true).installed).toBe(false); expect(once.rawListeners('request')).toEqual(onceBefore)
    expect(installSessionFrontend(f.server, FRONT445_MOUNT, 'changed', true).installed).toBe(false)
    expect(binding.ready()).toBe(false)
    const old = front445Pair(undefined, '/mcp', 'GET'); f.server.emit('request', old.req, old.res)
    expect(f.entered).toEqual(['/mcp']); expect(old.res.writableEnded).toBe(false)
    const denied = front445Pair(); f.server.emit('request', denied.req, denied.res); expect(denied.res.statusCode).toBe(503)
    f.server.emit('close'); expect(binding.installed).toBe(false)
  })
  it('O_loading_prior_late_foreign_and_native_finish_before_terminate', async () => {
    const f = front445Server(), binding = installSessionFrontend(f.server, FRONT445_MOUNT, 'literal-v1', true)
    const socket = new Front445Socket(); f.server.emit('connection', socket)
    const loading = front445Pair(socket, '/loading-foreign', 'GET'); f.server.emit('request', loading.req, loading.res)
    expect(hasNativeSessionOwnership(loading.req as any)).toBe(true); expect(loading.res.writableEnded).toBe(false)
    expect(binding.bindApp(f.app, handler => handler)).toBe(true); f.publish()
    const denied = front445Pair(socket); f.server.emit('request', denied.req, denied.res)
    expect(denied.res.statusCode).toBe(400); expect(denied.res.writableEnded).toBe(true)
    expect(denied.headers['content-length']).toBe(denied.res.bytes.byteLength)
    expect(JSON.parse(denied.res.bytes.toString())).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'invalid_framing', data: { code: 'invalid_framing' } } })
    await Promise.resolve(); expect(socket.destroys).toBe(0) // end() alone is not finish.
    denied.res.finish()
    const late = front445Pair(socket, '/later-foreign', 'GET'); f.server.emit('request', late.req, late.res)
    await Promise.resolve(); expect(socket.destroys).toBe(0)
    loading.endRequest(); loading.res.finish(); await Promise.resolve(); expect(socket.destroys).toBe(0)
    late.endRequest(); late.res.finish(); await Promise.resolve(); expect(socket.destroys).toBe(1)
    expect(denied.res.listenerCount('finish')).toBe(0); expect(denied.res.listenerCount('close')).toBe(0)
    expect(f.entered).toEqual(['/loading-foreign', '/mcp-session', '/later-foreign'])
  })
  it('P_prelisten_loading_foreign_never_confers_destruction_authority', async () => {
    const f = front445Server(), socket = new Front445Socket()
    const loading = front445Pair(socket, '/already-loading', 'GET')
    f.server.emit('request', loading.req, loading.res) // BEFORE hook: no inventable public owner.
    expect(hasNativeSessionOwnership(loading.req as any)).toBe(false)
    const binding = installSessionFrontend(f.server, FRONT445_MOUNT, 'literal-v1', true)
    expect(binding.bindApp(f.app, handler => handler)).toBe(true); f.publish()
    const denied = front445Pair(socket); f.server.emit('request', denied.req, denied.res)
    expect(denied.res.statusCode).toBe(400); denied.res.finish(); await Promise.resolve()
    expect(socket.destroys).toBe(0); expect(socket.closed).toBe(false)
    loading.endRequest(); loading.res.finish(); await Promise.resolve()
    expect(socket.destroys).toBe(0) // Cannot infer ALL earlier foreign requests from one completion.
    const old = front445Pair(socket, '/mcp', 'GET'); f.server.emit('request', old.req, old.res)
    expect(f.entered).toContain('/mcp'); expect(old.res.writableEnded).toBe(false)
    socket.closed = true; socket.emit('close') // Explicit real peer close, not fake release.
    expect(socket.destroys).toBe(0); expect(denied.res.listenerCount('finish')).toBe(0)
  })
  it('C_compiled_direct_listener_uses_same_gate_and_preserves_old_arguments', async () => {
    let called = 0, originalThis: unknown, originalReq: unknown
    const context = {}
    const listener = ownAllRequests(function (this: unknown, req) { called++; originalThis = this; originalReq = req }, FRONT445_MOUNT)
    const old = front445Pair(undefined, '/mcp?x=1', 'POST')
    Reflect.apply(listener, context, [old.req, old.res]); expect(called).toBe(1); expect(originalThis).toBe(context); expect(originalReq).toBe(old.req)
    const bad = front445Pair(); Reflect.apply(listener, context, [bad.req, bad.res])
    expect(called).toBe(1); expect(bad.res.statusCode).toBe(400); expect(bad.socket.destroys).toBe(0)
    bad.res.finish(); await Promise.resolve(); expect(bad.socket.destroys).toBe(1)
    const legal = front445Pair(undefined, '/mcp-session', 'POST', ['Content-Length', '1'])
    Reflect.apply(listener, context, [legal.req, legal.res]); expect(called).toBe(2)
    const unavailable = ownAllRequests(() => { throw new Error('unassembled new route dispatched') }, FRONT445_MOUNT, false)
    const unavailableBad = front445Pair(); Reflect.apply(unavailable, context, [unavailableBad.req, unavailableBad.res]); expect(unavailableBad.res.statusCode).toBe(503)
    expect(JSON.parse(unavailableBad.res.bytes.toString()).error.data.code).toBe('session_binding_unavailable')
  })
})

describe('445 public H3 SDK body replay', () => {
  it('P_consumed_web_request_400_and_cached_fresh_request_initialize_200', async () => {
    const fs = await import('node:fs/promises')
    const { createHash, randomUUID } = await import('node:crypto')
    const { tmpdir } = await import('node:os')
    const { pathToFileURL } = await import('node:url')
    const { createApp, eventHandler, toWebHandler, readBody } = await import('h3')
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
    const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    const compatPath = join(dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit'))), 'runtime/server/mcp/compat.js')
    const { toWebRequest } = await import(/* @vite-ignore */ pathToFileURL(compatPath).href)
    const literal = { jsonrpc: '2.0', id: 445, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '445-body-pair', version: '1' } } }
    const bytes = new TextEncoder().encode(JSON.stringify(literal))
    expect(bytes.byteLength).toBeLessThanOrEqual(16384)
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(bytes.byteLength) })
    const url = 'http://445-owned.invalid/mcp-session'
    for (const fresh of [false, true]) {
      const side = fresh ? 'B' : 'A'
      let initEntered = 0, initSettled = 0, middlewareParsed = false
      let closeServer = false, closeTransport = false
      // Public constructor registration interception preserves SDK's actual default
      // initialize handler; no registry/controller reads or dispatcher copy.
      type SDKHandler = Parameters<InstanceType<typeof Server>['setRequestHandler']>[1]
      class ObservedServer extends Server {
        override setRequestHandler<T extends AnyObjectSchema>(...args: [schema: T, handler: (request: SchemaOutput<T>, extra: Parameters<SDKHandler>[1]) => ReturnType<SDKHandler>]) {
          const [schema, handler] = args
          return super.setRequestHandler(schema, (request, extra) => {
            if (request.method !== 'initialize') return handler(request, extra)
            initEntered++
            try { return Promise.resolve(handler(request, extra)).finally(() => { initSettled++ }) }
            catch (error) { initSettled++; throw error }
          })
        }
      }
      const server = new ObservedServer({ name: '445-body-server', version: '1' }, { capabilities: {} })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true })
      try {
        await server.connect(transport)
        const app = createApp()
        app.use(eventHandler(async event => {
          const parsed = await readBody(event, { strict: false })
          expect(parsed).toEqual(literal); middlewareParsed = true
          const original = event.web?.request
          expect(original).toBeInstanceOf(Request)
          expect(original!.bodyUsed).toBe(true)
          if (fresh) {
            // readBody's public parsed cache remains the same object; SDK sees a
            // new Request over exactly the same bounded bytes and headers.
            event.web!.request = new Request(original!.url, { method: original!.method, headers: original!.headers, body: bytes })
            expect(await readBody(event, { strict: false })).toBe(parsed)
            expect(event.web!.request.url).toBe(url)
            expect(event.web!.request.method).toBe('POST')
            expect([...event.web!.request.headers]).toEqual([...headers])
            expect(new Uint8Array(await event.web!.request.clone().arrayBuffer())).toEqual(bytes)
          }
          const request = toWebRequest(event)
          expect(request).toBe(event.web!.request)
          expect(request.bodyUsed).toBe(!fresh)
          return transport.handleRequest(request)
        }))
        const response = await toWebHandler(app)(new Request(url, { method: 'POST', headers, body: bytes }))
        const payload = await response.json()
        const errorCode = typeof payload?.error?.code === 'number' && [-32700, -32600, -32000].includes(payload.error.code) ? payload.error.code : null
        const sidPresent = typeof transport.sessionId === 'string'
        const sidEqual = sidPresent && response.headers.get('mcp-session-id') === transport.sessionId
        expect(middlewareParsed).toBe(true)
        if (!fresh) {
          expect(response.status).toBe(400)
          expect(payload.error?.code).toBe(-32700)
          expect(initEntered).toBe(0); expect(initSettled).toBe(0)
          expect(sidPresent).toBe(false); expect(response.headers.has('mcp-session-id')).toBe(false)
        } else {
          expect(response.status).toBe(200)
          expect(payload).toEqual({ jsonrpc: '2.0', id: 445, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: '445-body-server', version: '1' } } })
          expect(initEntered).toBe(1); expect(initSettled).toBe(1)
          expect(sidPresent).toBe(true); expect(sidEqual).toBe(true)
        }
      } finally {
        try { await server.close(); closeServer = true }
        finally {
          await transport.close(); closeTransport = true
        }
      }
      expect(closeServer).toBe(true); expect(closeTransport).toBe(true)
    }
  }, 15000)
})
