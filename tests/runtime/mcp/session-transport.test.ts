











import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

let sequence = 0

import { createSessionAdmission } from '../../../layers/core/server/utils/mcp-session-admission'

function admissionDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function admissionLease(admission: ReturnType<typeof createSessionAdmission>) {
  const result = admission.reserve()
  if (!result.ok) throw new Error('test reservation unexpectedly rejected')
  return result.lease
}

describe('A_actual_session_admission', () => {
  it('A_pending_7_8_9_no_ninth_factory', async () => {
    const a = createSessionAdmission()
    const gates = Array.from({ length: 8 }, () => admissionDeferred<number>())
    let factories = 0
    const starts: Promise<unknown>[] = []
    for (let i = 0; i < 7; i++) starts.push(admissionLease(a).initialize(() => { factories++; return gates[i]!.promise }, async () => {}))
    expect(a.snapshot()).toEqual({ pending: 7, ready: 0, closing: 0, total: 7, accepting: true })
    starts.push(admissionLease(a).initialize(() => { factories++; return gates[7]!.promise }, async () => {}))
    expect(a.snapshot().pending).toBe(8)
    const ninth = a.reserve()
    if (ninth.ok) starts.push(ninth.lease.initialize(async () => { factories++; return 9 }, async () => {}))
    expect(ninth).toEqual({ ok: false, reason: 'pending_capacity' })
    expect(factories).toBe(8)
    expect(a.snapshot().total).toBe(8)
    gates.forEach((gate, i) => gate.resolve(i))
    await Promise.all(starts)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 8, closing: 0, total: 8, accepting: true })
    expect(a.shutdown().complete).toBe(false)
    await Promise.resolve(); await Promise.resolve()
    expect(a.shutdown().complete).toBe(true)
  })

  it('A_total_63_64_65_includes_closing', async () => {
    const a = createSessionAdmission()
    const release = admissionDeferred<void>()
    const leases = []
    for (let i = 0; i < 63; i++) {
      const lease = admissionLease(a); leases.push(lease)
      expect(await lease.initialize(async () => i, () => release.promise)).toEqual({ ok: true, value: i })
    }
    expect(a.snapshot()).toEqual({ pending: 0, ready: 63, closing: 0, total: 63, accepting: true })
    const last = admissionLease(a); leases.push(last)
    expect(a.snapshot().total).toBe(64)
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    const closing = leases[0]!.close()
    expect(a.snapshot()).toEqual({ pending: 1, ready: 62, closing: 1, total: 64, accepting: true })
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    release.resolve()
    await closing
    expect(a.snapshot().total).toBe(63)
    const replacement = admissionLease(a)
    expect(a.snapshot().total).toBe(64)
    await replacement.close()
    await Promise.all(leases.map(lease => lease.close()))
    expect(a.snapshot().total).toBe(0)
  })

  it('A_close_unstarted_closed_and_single_initialize', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const first = lease.close()
    expect(lease.close()).toBe(first)
    expect(await first).toEqual({ complete: true })
    let calls = 0
    expect(await lease.initialize(async () => { calls++; return 1 }, async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(calls).toBe(0)
    expect(lease.state()).toBe('closed')
    expect(a.snapshot().total).toBe(0)
    const next = admissionLease(a)
    expect(next.generation > lease.generation).toBe(true)
    expect(await next.initialize(async () => 2, async () => {})).toEqual({ ok: true, value: 2 })
    expect(await next.initialize(async () => { calls++; return 3 }, async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(calls).toBe(0)
    expect(a.snapshot().total).toBe(1)
    await next.close()
  })

  it('A_revoke_pending_late_resolve_never_publishes', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const factory = admissionDeferred<object>(); const cleanup = admissionDeferred<void>()
    const value = { private: 'credential-event' }; let cleaned: unknown; let cleanCalls = 0
    const start = lease.initialize(() => factory.promise, resource => { cleaned = resource; cleanCalls++; return cleanup.promise })
    const close = lease.close()
    expect(lease.close()).toBe(close)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 1, total: 1, accepting: true })
    factory.resolve(value)
    await Promise.resolve()
    expect(cleaned).toBe(value); expect(cleanCalls).toBe(1)
    expect(lease.state()).toBe('closing')
    cleanup.resolve()
    expect(await start).toEqual({ ok: false, reason: 'revoked' })
    expect(await close).toEqual({ complete: true })
    expect(a.snapshot().total).toBe(0)
    expect(await lease.close()).toEqual({ complete: true })
    expect(cleanCalls).toBe(1)
  })

  it('A_late_factory_reject_and_pending_reject_release', async () => {
    const a = createSessionAdmission()
    for (const revoke of [false, true]) {
      const lease = admissionLease(a); const gate = admissionDeferred<number>(); let cleans = 0
      const start = lease.initialize(() => gate.promise, async () => { cleans++ })
      if (revoke) lease.close()
      gate.reject(new Error('Bearer secret-token'))
      expect(await start).toEqual({ ok: false, reason: revoke ? 'revoked' : 'factory_failed' })
      expect(await lease.close()).toEqual({ complete: true })
      expect(cleans).toBe(0); expect(a.snapshot().total).toBe(0)
    }
    const lease = admissionLease(a)
    expect(await lease.initialize(() => { throw new Error('secret-sync') }, async () => {})).toEqual({ ok: false, reason: 'factory_failed' })
    expect(a.snapshot().total).toBe(0)
  })

  it('A_ready_duplicate_close_isolation_and_no_result_cache', async () => {
    const a = createSessionAdmission(); const first = admissionLease(a); const second = admissionLease(a)
    const gate = admissionDeferred<void>(); let cleans = 0
    await first.initialize(async () => 'one', () => { cleans++; return gate.promise })
    await second.initialize(async () => 'two', async () => {})
    const closing = first.close()
    expect(first.close()).toBe(closing); expect(cleans).toBe(1)
    expect(second.state()).toBe('ready')
    expect(a.snapshot()).toEqual({ pending: 0, ready: 1, closing: 1, total: 2, accepting: true })
    gate.resolve(); await closing
    expect(await first.initialize(async () => 'stale', async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(a.snapshot().total).toBe(1)
    await second.close(); await first.close()
    expect(cleans).toBe(1); expect(a.snapshot().total).toBe(0)
  })

  it('A_cleanup_reject_retains_charge_and_safe_errors', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a); let cleans = 0
    await lease.initialize(async () => ({ token: 'Bearer private-event' }), () => { cleans++; throw new Error('Bearer private-event') })
    const close = lease.close()
    expect(await close).toEqual({ complete: false, reason: 'cleanup_failed' })
    expect(lease.close()).toBe(close); expect(cleans).toBe(1)
    expect(lease.state()).toBe('closing')
    expect(a.shutdown()).toEqual({ complete: false, pending: 0, ready: 0, closing: 1, total: 1, accepting: false })
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
    expect(JSON.stringify([a.snapshot(), await close])).not.toContain('private-event')
    expect(JSON.stringify(a.snapshot())).not.toContain('token')
  })

  it('A_never_factory_and_cleanup_bounded_shutdown', async () => {
    const a = createSessionAdmission(); const pending = admissionLease(a); const ready = admissionLease(a)
    const never = admissionDeferred<number>(); const neverClean = admissionDeferred<void>()
    void pending.initialize(() => never.promise, async () => {})
    await ready.initialize(async () => 1, () => neverClean.promise)
    const shutdown = a.shutdown()
    expect(shutdown).toEqual({ complete: false, pending: 0, ready: 0, closing: 2, total: 2, accepting: false })
    expect(a.shutdown()).toEqual(shutdown)
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
    expect(pending.state()).toBe('closing'); expect(ready.state()).toBe('closing')
    // Controlled promises intentionally remain unresolved; no timer/network handles.
  })

  it('A_shutdown_empty_unstarted_and_closed_is_idempotent', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    expect(a.shutdown()).toEqual({ complete: true, pending: 0, ready: 0, closing: 0, total: 0, accepting: false })
    expect(await lease.close()).toEqual({ complete: true })
    expect(a.shutdown().complete).toBe(true)
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
  })
})

describe('A_actual_session_admission', () => {
  it('A_revoked_late_cleanup_reject_stays_charged', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const factory = admissionDeferred<number>(); let cleans = 0
    const start = lease.initialize(() => factory.promise, async () => { cleans++; throw new Error('private-late-token') })
    const close = lease.close()
    factory.resolve(1)
    expect(await start).toEqual({ ok: false, reason: 'revoked' })
    expect(await close).toEqual({ complete: false, reason: 'cleanup_failed' })
    expect(lease.close()).toBe(close); expect(cleans).toBe(1)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 1, total: 1, accepting: true })
    expect(a.shutdown().complete).toBe(false)
  })

  it('A_never_resolving_revocations_cannot_escape_total_bound', () => {
    const a = createSessionAdmission()
    const never = admissionDeferred<number>()
    for (let i = 0; i < 64; i++) {
      const lease = admissionLease(a)
      void lease.initialize(() => never.promise, async () => {})
      void lease.close()
    }
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 64, total: 64, accepting: true })
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    expect(a.shutdown()).toEqual({ complete: false, pending: 0, ready: 0, closing: 64, total: 64, accepting: false })
  })
})

import { createSessionInitializationTransport as createActualSessionInitializationTransport, type InitializationDependencies, type SessionOwner, type OwnedIngress } from '../../../layers/core/server/utils/mcp-session-transport'

function controlledPeer() {
  const receipt=admissionDeferred<{closed:true}>(),listeners=new Set<()=>void>();let ended=false
  return {closed:receipt.promise,subscribeClosed(listener:()=>void){if(ended){listener();return ()=>{}}listeners.add(listener);return ()=>{listeners.delete(listener)}},
    close(){if(ended)return;ended=true;receipt.resolve({closed:true});for(const listener of [...listeners])listener();listeners.clear()},observerCount:()=>listeners.size}
}

function createSessionInitializationTransport<E, O extends SessionOwner>(deps: Omit<InitializationDependencies<E, O>, 'replay'>) {
  const adapter = createActualSessionInitializationTransport({ ...deps, replay: async (event, _request, run) => run(event) })
  return { ...adapter, async handle(event: E, request: Request) {
    const bytes = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : null
    const headers = new Headers(request.headers)
    if (bytes) headers.set('content-length', String(bytes.length))
    const input: OwnedIngress = { method: request.method, url: request.url, headers, rawHeaders: [...headers],
      body: bytes ? new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }) : null,
      ...controlledPeer(), responseFinished: Promise.resolve({finished:true}), terminate() {},
    }
    return adapter.handle(event, input)
  } }
}

describe('T_pure_controls', () => {
  it('T_pure_invalid_identity_and_unsupported_rpc', async () => {
    let factories = 0
    const owner = { close: async () => {}, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }),
      factory: () => { factories++; return owner }, provider: async () => new Response(), adopted: () => owner, cleanupSession: async () => ({ empty: true as const }),
    })
    const invalid = await adapter.handle({}, new Request('http://local', { method: 'POST', headers: { authorization: '' }, body: '{}' }))
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({ error: { data: { code: 'invalid_identity' } } })
    const unsupported = await adapter.handle({}, new Request('http://local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }) }))
    expect(unsupported.status).toBe(501); expect(factories).toBe(0)
    expect(adapter.shutdown().complete).toBe(true)
  })

  it('T_pure_late_provider_reconciles_without_publish', async () => {
    const entered = admissionDeferred<void>(); const response = admissionDeferred<Response>(); let closed = 0; let cleared = 0
    const owner = { close: async () => { closed++ }, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }), factory: () => owner,
      provider: async () => { const transport = { sessionId: undefined as string | undefined, close: async () => {} }; await owner.connect(transport); transport.sessionId = 'late'; entered.resolve(); return response.promise }, adopted: () => owner,
      cleanupSession: async () => { cleared++; return { empty: true as const } },
    })
    const pending = adapter.handle({}, new Request('http://local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) }))
    await entered.promise
    expect(adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    response.resolve(new Response('{}', { headers: { 'mcp-session-id': 'late' } }))
    const rejected = await pending
    expect(rejected.status).toBe(503); expect(rejected.headers.has('mcp-session-id')).toBe(false)
    expect(closed).toBe(1); expect(cleared).toBe(1); expect(adapter.shutdown().complete).toBe(true)
  })

  it('T_pure_cleanup_failure_and_wrong_identity_preserve_charge', async () => {
    let epoch = 1; let closed = 0
    const owner = { close: async () => { closed++ }, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'authorized' as const, principal: 'owner', epoch }), factory: () => owner,
      provider: async () => { const transport = { sessionId: undefined as string | undefined, close: async () => {} }; await owner.connect(transport); transport.sessionId = 'owned'; return new Response('{}', { headers: { 'mcp-session-id': 'owned' } }) }, adopted: () => owner,
      cleanupSession: async () => { throw new Error('private-credential') },
    })
    const headers = { authorization: 'Bearer test-only' }
    const initialized = await adapter.handle({}, new Request('http://local', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) }))
    expect(initialized.status).toBe(200)
    epoch = 2
    expect((await adapter.handle({}, new Request('http://local', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': 'owned' } }))).status).toBe(404)
    expect(closed).toBe(0); expect(adapter.snapshot().ready).toBe(1)
    epoch = 1 // Pure identity comparison only; NOT a trusted monotonic epoch source.
    const deletion = await adapter.handle({}, new Request('http://local', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': 'owned' } }))
    expect(deletion.status).toBe(503)
    expect(await deletion.text()).not.toContain('private-credential')
    expect(adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    expect(closed).toBe(1)
  })

})

function resourceARequest(method = 'POST', sid?: string) {
  return new Request('http://local', { method, headers: sid ? { 'mcp-session-id': sid } : {}, ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) } : {}) })
}

function resourceAHarness(...receipts: unknown[]) {
  const receipt = receipts.length ? receipts[0] : { empty: true }
  const log: string[] = []
  let nextSid = 'owned-a'; let header: string | undefined; let failProvider = false; let failCleanup = false; let failOwner = false; let failTransport = false
  let adopted: any
  const adapter = createSessionInitializationTransport({
    authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }),
    factory: () => {
      const name = nextSid
      let connected: any
      const owner = { connect: async (transport: any) => { connected = transport }, close: async () => { log.push('owner:' + name); if (failOwner) throw new Error('private-owner'); await connected?.close() } }
      adopted = owner
      return owner
    },
    provider: async factory => {
      const owner = factory()
      const allocated = nextSid
      const transport = { sessionId: undefined as string | undefined, close: async () => { log.push('transport:' + allocated); if (failTransport) throw new Error('private-transport') } }
      await owner.connect(transport)
      transport.sessionId = nextSid
      log.push('allocated:' + transport.sessionId)
      if (failProvider) throw new Error('private-provider')
      return new Response('{}', { headers: { 'mcp-session-id': header ?? nextSid } })
    },
    adopted: () => adopted,
    cleanupSession: async sid => { log.push('storage:' + sid); if (failCleanup) throw new Error('private-storage'); return receipt as { empty: true } },
  })
  return { adapter, log, configure(options: { sid?: string; header?: string; provider?: boolean; cleanup?: boolean; owner?: boolean; transport?: boolean }) {
    if (options.sid) nextSid = options.sid
    header = options.header; failProvider = !!options.provider; failCleanup = !!options.cleanup; failOwner = !!options.owner; failTransport = !!options.transport
  } }
}

describe('U_resourceA_pure', () => {
  it('U_transport_close_failure_still_cleans_storage_and_retains_charge', async () => {
    const h = resourceAHarness(); h.configure({provider:true,transport:true})
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.log).toEqual(['allocated:owned-a','owner:owned-a','transport:owned-a','storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:1,total:1})
  })
  it('U_receipt_pending_holds_charge_until_verified', async () => {
    const receipt = admissionDeferred<{empty:true}>()
    const h = resourceAHarness(receipt.promise); h.configure({provider:true})
    const request = h.adapter.handle({}, resourceARequest())
    await expect.poll(() => h.log.includes('storage:owned-a')).toBe(true)
    expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1})
    receipt.resolve({empty:true})
    expect((await request).status).toBe(500)
    expect(h.adapter.snapshot().total).toBe(0)
  })

  for (const [name, receipt] of [
    ['U_false_receipt_retains_charge', {empty:false}],
    ['U_malformed_receipt_retains_charge', {empty:'true'}],
    ['U_missing_receipt_retains_charge', undefined],
  ] as const) it(name, async () => {
    const h = resourceAHarness(receipt)
    h.configure({provider:true})
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:1,total:1})
    expect(h.adapter.shutdown().total).toBe(1)
    expect(h.log).toEqual(['allocated:owned-a','owner:owned-a','transport:owned-a','storage:owned-a'])
  })
  it('U_sid_normalization_delimiters_never_claim_or_clear', async () => {
    for (const sid of ['owner:child','owner/child','owner?query','owner\\child']) {
      const h = resourceAHarness(); h.configure({sid})
      expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
      expect(h.log.some(item => item.startsWith('allocated:'))).toBe(false)
      expect(h.log.some(item => item.startsWith('storage:'))).toBe(false)
      expect(h.adapter.snapshot().total).toBe(0)
    }
  })

  it('U_post_allocation_throw_closes_owner_transport_and_exact_storage', async () => {
    const h = resourceAHarness(); h.configure({ provider: true })
    const response = await h.adapter.handle({}, resourceARequest())
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private-provider')
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.snapshot().total).toBe(0)
    expect(h.adapter.shutdown().complete).toBe(true)
  })
  it('U_cleanup_rejection_keeps_closing_charge', async () => {
    const h = resourceAHarness(); h.configure({ provider: true, cleanup: true })
    const response = await h.adapter.handle({}, resourceARequest())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-storage')
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    expect(h.adapter.shutdown().total).toBe(1)
    expect(h.log.length).toBe(4)
  })
  it('U_owner_close_failure_still_closes_transport_and_clears_storage', async () => {
    const h = resourceAHarness(); h.configure({ provider: true, owner: true })
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
  })
  it('U_header_mismatch_never_cleans_foreign_sid', async () => {
    const h = resourceAHarness()
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(200)
    h.configure({ sid: 'owned-b', header: 'owned-a' })
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
    expect(h.log).toEqual(['allocated:owned-a', 'allocated:owned-b', 'owner:owned-b', 'transport:owned-b', 'storage:owned-b'])
    expect(h.adapter.snapshot()).toMatchObject({ ready: 1, total: 1 })
    expect((await h.adapter.handle({}, resourceARequest('DELETE', 'owned-a'))).status).toBe(204)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(1)
    expect(h.adapter.snapshot().total).toBe(0)
  })
  it('U_sid_collision_rejected_before_provider_publication', async () => {
    const h = resourceAHarness()
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(200)
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
    expect(h.log.filter(item => item === 'allocated:owned-a')).toHaveLength(1)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(0)
    expect(h.adapter.snapshot()).toMatchObject({ ready: 1, total: 1 })
    expect((await h.adapter.handle({}, resourceARequest('DELETE', 'owned-a'))).status).toBe(204)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(1)
    expect(h.adapter.shutdown().complete).toBe(true)
  })
})

function bodyClock() {
  let now = 0, next = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn: () => void, delay: number) { const id = ++next; jobs.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id: unknown) { jobs.delete(id as number) },
    async advance(ms: number) { for (let i = 0; i < 12; i++) await Promise.resolve(); now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn() }; for (let i = 0; i < 12; i++) await Promise.resolve() },
  }
}

function bodyHarness(options: { bytes?: Uint8Array; raw?: Array<[string,string]>; stall?: boolean; close?: 'immediate'|'late'|'reject'|'never'; context?: string } = {}) {
  const peer=controlledPeer(),closed={promise:peer.closed,resolve:(_receipt:{closed:true})=>peer.close()}
  let controller!: ReadableStreamDefaultController<Uint8Array>, terminated = 0, factories = 0
  const clock = bodyClock(), context = { marker: options.context ?? 'body-context' }
  const bytes = options.bytes ?? new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"method":"initialize"}')
  const stream = new ReadableStream<Uint8Array>({start(c) { controller = c; if (!options.stall) { c.enqueue(bytes); c.close() } }})
  const ingress = { method:'POST', url:'http://unit/adapter', headers:new Headers({'content-type':'application/json','content-length':String(bytes.length)}), rawHeaders:options.raw ?? [['content-length',String(bytes.length)]], body:stream, closed:closed.promise,subscribeClosed:peer.subscribeClosed,
    terminate() { terminated++; if (options.close === 'reject') return Promise.reject(new Error('termination rejected')); if (!options.close || options.close === 'immediate') { controller.error(new Error('terminated')); closed.resolve({closed:true}) } },
  }
  const replayed: any[] = []
  let owner: any
  const adapter = createActualSessionInitializationTransport({
    clock,
    authenticate: (event: typeof context) => { expect(event).toBe(context); return {kind:'anonymous' as const,epoch:1} },
    replay: async (event: typeof context, request: Request, run: (event: typeof context)=>Promise<Response>) => { replayed.push({bytes:Array.from(new Uint8Array(await request.arrayBuffer())),marker:event.marker}); return run(event) },
    factory: () => { factories++; owner = {connect:async (_connection: unknown)=>{},close:async()=>{}}; return owner },
    provider: async (factory: ()=>any) => { const candidate=factory(); const connection={sessionId:undefined as string|undefined,close:async()=>{}}; await candidate.connect(connection); connection.sessionId='body-owned'; return new Response('{}',{headers:{'mcp-session-id':'body-owned'}}) },
    adopted:()=>owner,cleanupSession:async()=>({empty:true as const}),
  })
  return {adapter,ingress,context,clock,replayed,closed,finish() {controller.close()},counts:()=>({terminated,factories})}
}

describe('B_ingress_pure', () => {
  for (const size of [16383,16384]) it('B_bytes_' + size + '_exact_replay', async () => {
    const prefix='{"jsonrpc":"2.0","id":0,"method":"initialize","padding":"'
    const bytes=new TextEncoder().encode(prefix+'x'.repeat(size-prefix.length-2)+'"}')
    expect(bytes.length).toBe(size)
    const h=bodyHarness({bytes});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(200)
    expect(h.replayed).toEqual([{bytes:Array.from(bytes),marker:'body-context'}])
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:0,total:0})
    expect(h.counts()).toEqual({terminated:0,factories:1}); h.adapter.shutdown()
  })
  it('B_bytes_16385_rejected_before_factory', async () => {
    const h=bodyHarness({bytes:new Uint8Array(16385)})
    expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(413)
    expect(h.counts()).toEqual({terminated:1,factories:0})
    expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_40_reading_41_rejected_and_eof_once', async () => {
    const h=bodyHarness({stall:true,close:'late'})
    const ingresses=Array.from({length:40},()=>{const done=admissionDeferred<{closed:true}>();let c!:ReadableStreamDefaultController<Uint8Array>;return {done,get c(){return c},input:{...h.ingress,body:new ReadableStream<Uint8Array>({start(x){c=x}}),closed:done.promise,terminate:()=>{}}}})
    const pending=ingresses.map(x=>h.adapter.handle(h.context,x.input))
    expect(h.adapter.bodySnapshot()).toEqual({reading:40,closing:0,total:40})
    expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(503)
    for(const x of ingresses){x.c.close();x.done.resolve({closed:true})}
    await Promise.all(pending)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:0,total:0})
    for(const x of ingresses)x.done.resolve({closed:true})
    expect(h.adapter.bodySnapshot().total).toBe(0)
    expect(h.counts().factories).toBe(0)
  })
  it('B_deadline_5000_late_close_and_250_observation', async () => {
    const h=bodyHarness({stall:true,close:'late'});const pending=h.adapter.handle(h.context,h.ingress)
    await h.clock.advance(4999);expect(h.counts().terminated).toBe(0)
    await h.clock.advance(1);expect(h.counts().terminated).toBe(1)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:1,total:1})
    await h.clock.advance(250);expect((await pending).status).toBe(408)
    expect(h.adapter.bodySnapshot().total).toBe(1)
    h.closed.resolve({closed:true});await h.clock.advance(0)
    expect(h.adapter.bodySnapshot().total).toBe(0)
    h.closed.resolve({closed:true});expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  for(const close of ['reject','never'] as const) it('B_termination_'+close+'_retains_closing', async()=>{
    const h=bodyHarness({stall:true,close});const pending=h.adapter.handle(h.context,h.ingress)
    await h.clock.advance(5000);await h.clock.advance(250)
    expect((await pending).status).toBe(408)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:1,total:1})
    expect(h.counts()).toEqual({terminated:1,factories:0})
  })
  for(const [name,raw] of [
    ['duplicate_cl',[['content-length','44'],['Content-Length','44']]],
    ['te',[['transfer-encoding','chunked']]],
    ['cl_te',[['content-length','44'],['transfer-encoding','chunked']]],
    ['compression',[['content-length','44'],['content-encoding','gzip']]],
    ['nondecimal',[['content-length','+44']]],
    ['missing_cl',[]],
  ] as Array<[string,Array<[string,string]>]>) it('B_framing_'+name,async()=>{
    const h=bodyHarness({raw});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(400)
    expect(h.counts()).toEqual({terminated:1,factories:0});expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_actual_bytes_must_match_content_length',async()=>{
    const h=bodyHarness({raw:[['content-length','100']]});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(400)
    expect(h.counts().factories).toBe(0);expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_distinct_context_and_bytes_do_not_bleed',async()=>{
    const a=bodyHarness({context:'A'}),b=bodyHarness({context:'B'})
    await Promise.all([a.adapter.handle(a.context,a.ingress),b.adapter.handle(b.context,b.ingress)])
    expect(a.replayed[0].marker).toBe('A');expect(b.replayed[0].marker).toBe('B')
    a.adapter.shutdown();b.adapter.shutdown()
  })
})

import { createSocketOwnership } from '../../../layers/core/server/utils/mcp-session-transport'

describe('W_socket_ownership_pure', () => {
  it("_socket_observers_detach_and_already_closed_notify_once",()=>{
    const manager=createSocketOwnership<object>(),socket={};let calls=0
    for(let i=0;i<80;i++){const h=manager.register(socket,()=>{}),detach=h.subscribeClosed(()=>{calls++});expect(manager.observerCount(socket)).toBe(1);detach();detach();h.requestFinished();h.responseFinished();expect(manager.observerCount(socket)).toBe(0);expect(manager.snapshot(socket).active).toBe(0)}
    const h=manager.register(socket,()=>{});h.subscribeClosed(()=>{calls++;throw new Error('observer failure')});const sibling=manager.register(socket,()=>{});sibling.subscribeClosed(()=>{calls++});manager.closed(socket);expect(calls).toBe(2);expect(manager.observerCount(socket)).toBe(0);h.subscribeClosed(()=>{calls++});expect(calls).toBe(3)
  })

  it('W_dynamic_later_owner_blocks_close_until_both_halves_finish', async () => {
    const manager=createSocketOwnership<object>();const socket={};let destroys=0
    const prior=manager.register(socket,()=>{destroys++}), failed=manager.register(socket,()=>{destroys++})
    failed.terminate();failed.terminate();prior.requestFinished();prior.responseFinished()
    const later=manager.register(socket,()=>{destroys++})
    await Promise.resolve();expect(destroys).toBe(0)
    later.responseFinished();await Promise.resolve();expect(destroys).toBe(0)
    later.requestFinished();await Promise.resolve();expect(destroys).toBe(1)
    let acknowledged=false;failed.closed.then(()=>{acknowledged=true});await Promise.resolve();expect(acknowledged).toBe(false)
    manager.closed(socket);await Promise.resolve();expect(acknowledged).toBe(true)
    failed.terminate();later.responseFinished();await Promise.resolve();expect(destroys).toBe(1)
  })
  it('W_never_prior_keeps_forty_pending_and_other_socket_isolated', async()=>{
    const manager=createSocketOwnership<object>();const socket={},other={};let destroyed=0,otherDestroyed=0
    const prior=manager.register(socket,()=>{destroyed++})
    const held=Array.from({length:40},()=>manager.register(socket,()=>{destroyed++}))
    held.forEach(x=>x.terminate());prior.requestFinished();await Promise.resolve()
    expect(manager.snapshot(socket)).toEqual({active:41,terminating:40,destroyRequested:false,closed:false});expect(destroyed).toBe(0)
    const independent=manager.register(other,()=>{otherDestroyed++});independent.terminate();await Promise.resolve()
    expect(otherDestroyed).toBe(1);expect(destroyed).toBe(0)
    manager.closed(other);await independent.closed
    expect(manager.snapshot(socket).terminating).toBe(40)
  })
  it('W_completed_handle_cannot_destroy_reused_connection',async()=>{
    const manager=createSocketOwnership<object>();const socket={};let destroyed=0
    const old=manager.register(socket,()=>{destroyed++});old.requestFinished();old.responseFinished()
    const current=manager.register(socket,()=>{destroyed++});old.terminate();await Promise.resolve();expect(destroyed).toBe(0)
    current.terminate();await Promise.resolve();expect(destroyed).toBe(1)
    expect(()=>manager.register(socket,()=>{})).toThrow('socket_closing')
    manager.closed(socket);await current.closed
  })
})

function quotaHarness(missingHandlerReceipt=false) {
  let sequence=0,provided=0
  const owners=new Map<string,any>()
  const adapter=createActualSessionInitializationTransport<any,any>({
    authenticate:e=>({kind:'authorized',epoch:1,principal:e.token??'A'}),
    replay:async(e,request,run)=>{e.request=request;return run(e)},
    factory:()=>({connect:async()=>{},close:async()=>{}}),
    provider:async(factory,e)=>{
      provided++
      if(!e.sid){const owner=factory(),connection={sessionId:undefined as string|undefined,close:async()=>{},closeSSEStream:(_id:unknown)=>{}};await owner.connect(connection);connection.sessionId='quota'+(++sequence);owners.set(connection.sessionId,owner);e.owner=owner;return new Response('{}',{headers:{'mcp-session-id':connection.sessionId}})}
      return new Response('{}',{status:e.method==='notifications/cancelled'||e.method==='notifications/initialized'?202:200})
    },adopted:e=>e.owner,cleanupSession:async()=>({empty:true}),handlerFinished:e=>{if(missingHandlerReceipt)throw new Error('private-credential');return e.handler.promise},
  })
  function invoke(sid:string|undefined,id:any,method='tools/call',options:{token?:string;params?:any;padding?:number;delete?:boolean}={}) {
    const handler=admissionDeferred<{finished:true}>(),response=admissionDeferred<{finished:true}>()
    const message={jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params:options.params??{},...(options.padding?{padding:'x'.repeat(options.padding)}:{})}
    const bytes=new TextEncoder().encode(JSON.stringify(message));const headers=new Headers({authorization:'Bearer fixture',...(sid?{'mcp-session-id':sid}:{}),'content-length':String(bytes.length)})
    const event={sid,method,handler,token:options.token};const input={method:options.delete?'DELETE':'POST',url:'http://unit/adapter',headers,rawHeaders:[...headers] as Array<[string,string]>,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close()}}),...controlledPeer(),responseFinished:response.promise,terminate(){}}
    return {result:adapter.handle(event,input),handler:()=>handler.resolve({finished:true}),finish:()=>response.resolve({finished:true})}
  }
  return {adapter,invoke,provided:()=>provided,async session(){const call=invoke(undefined,0,'initialize');const result=await call.result;call.finish();expect(result.status).toBe(200);const sid=result.headers.get('mcp-session-id');expect(sid).toBeTypeOf('string');expect(sid).not.toBe('');return sid!}}
}

async function quotaFlush(){for(let i=0;i<20;i++)await Promise.resolve()}

describe('Q_rpc_quota_ids_pure',()=>{
  it("_UTF8_id128_129_and_cancel_reason_boundaries",async()=>{
    const h=quotaHarness(),sid=await h.session(),id='😀'.repeat(32)
    const before=h.adapter.requestSnapshot(),provided=h.provided();expect((await h.invoke(sid,id+'a').result).status).toBe(400);expect(h.provided()).toBe(provided);expect(h.adapter.requestSnapshot()).toEqual(before)
    const active=h.invoke(sid,id);expect((await active.result).status).toBe(200)
    for(const reason of ['😀'.repeat(256)+'a',42,null]){const snapshot=h.adapter.requestSnapshot(),n=h.provided();const bad=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:id,reason}});expect((await bad.result).status).toBe(400);expect(h.provided()).toBe(n);expect(h.adapter.requestSnapshot()).toEqual(snapshot)}
    for(const [i,reason] of ['😀'.repeat(255)+'abc','😀'.repeat(256)].entries()){const target=i===0?id:'second',call=i===0?active:h.invoke(sid,target);if(i)await call.result;const cancel=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:target,reason}});expect((await cancel.result).status).toBe(202);cancel.finish();call.handler();call.finish();await quotaFlush()}
    for(const [initId,status] of [[0,200],['😀'.repeat(32),200],['😀'.repeat(32)+'a',400]] as const){const n=h.provided(),init=h.invoke(undefined,initId,'initialize');expect((await init.result).status).toBe(status);init.finish();if(status===400)expect(h.provided()).toBe(n)}
    h.adapter.shutdown();await quotaFlush()
  })


  it('Q_missing_handler_receipt_safe_501_no_dispatch',async()=>{
    const h=quotaHarness(true),sid=await h.session(),before=h.provided()
    const call=h.invoke(sid,1,'tools/list'),response=await call.result
    expect(response.status).toBe(501);expect([...response.headers]).toEqual([['content-type','application/json']])
    const bytes=await response.text();expect(bytes).toBe(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'handler_receipt_unavailable',data:{code:'handler_receipt_unavailable'}}}))
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(256);expect(bytes).not.toContain('private-credential');expect(h.provided()).toBe(before)
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:0,control:0,charged:0});call.finish();h.adapter.shutdown();await quotaFlush()
  })

  it('Q_four_session_thirtytwo_global_no_queue_and_two_end_receipts',async()=>{
    const h=quotaHarness(),sids:string[]=[],calls:any[]=[]
    for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8))for(let id=1;id<=4;id++){const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);calls.push(c)}
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:32,control:0})
    expect((await h.invoke(sids[0],5).result).status).toBe(503);expect((await h.invoke(sids[8],1).result).status).toBe(503)
    calls[0].finish();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(32)
    calls[0].handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(31)
    calls[1].handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(31)
    calls[1].finish();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(30)
    calls.forEach(c=>{c.handler();c.finish()});await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(0)
  })
  it('Q_control_two_session_eight_global_separate_from_ordinary',async()=>{
    const h=quotaHarness(),sids=await Promise.all(Array.from({length:5},()=>h.session())),controls:any[]=[]
    const rpc=Array.from({length:4},(_,i)=>h.invoke(sids[0],i+1));await Promise.all(rpc.map(c=>c.result))
    for(const sid of sids.slice(0,4))for(let i=0;i<2;i++){const c=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:999}});expect((await c.result).status).toBe(202);controls.push(c)}
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:4,control:8})
    expect((await h.invoke(sids[0],undefined,'notifications/initialized').result).status).toBe(503)
    expect((await h.invoke(sids[4],undefined,'notifications/cancelled',{params:{requestId:999}}).result).status).toBe(503)
    controls.forEach(c=>c.finish());rpc.forEach(c=>{c.handler();c.finish()});await quotaFlush();expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:0,control:0})
  })
  it('Q_typed_ids_duplicate_zero_empty_and_lifetime256',async()=>{
    const h=quotaHarness(),sid=await h.session()
    for(const id of [0,''])expect((await h.invoke(sid,id).result).status).toBe(400)
    const a=h.invoke(sid,1),b=h.invoke(sid,'1');expect((await a.result).status).toBe(200);expect((await b.result).status).toBe(200)
    expect((await h.invoke(sid,1).result).status).toBe(409);a.handler();a.finish();b.handler();b.finish();await quotaFlush()
    expect((await h.invoke(sid,1).result).status).toBe(409)
    for(let id=2;id<=254;id++){const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush()}
    expect(h.adapter.requestSnapshot().distinctIds).toBe(256)
    expect((await h.invoke(sid,255).result).status).toBe(503)
  })
  it('Q_unknown_completed_repeat_cancel_no_forward_and_wrong_identity',async()=>{
    const h=quotaHarness(),sid=await h.session(),c=h.invoke(sid,1);await c.result
    const before=h.provided();const wrong=h.invoke(sid,undefined,'notifications/cancelled',{token:'B',params:{requestId:1}});expect((await wrong.result).status).toBe(404);expect(h.provided()).toBe(before)
    for(const id of [999,1,1]){const cancel=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:id}});expect((await cancel.result).status).toBe(202);cancel.finish();await quotaFlush()}
    expect(h.provided()).toBe(before+1);c.handler();c.finish();await quotaFlush()
    const done=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:1}});expect((await done.result).status).toBe(202);done.finish();await quotaFlush();expect(h.provided()).toBe(before+1)
    expect(h.adapter.requestSnapshot().distinctIds).toBe(2)
  })
  it('Q_exact_65535_65536_65537_and_delete_control_capacity',async()=>{
    const h=quotaHarness(),sid=await h.session()
    const overhead=Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{},padding:''}))
    for(const [id,size] of [[1,65535],[2,65536],[3,65537]] as const){
      const c=h.invoke(sid,id,'tools/call',{padding:size-overhead});expect((await c.result).status).toBe(size>65536?413:200);c.handler();c.finish();await quotaFlush()
    }
    const first=h.invoke(sid,undefined,'notifications/initialized'),second=h.invoke(sid,undefined,'notifications/initialized');await first.result;await second.result
    expect((await h.invoke(sid,undefined,'DELETE',{delete:true}).result).status).toBe(503)
    first.finish();second.finish();await quotaFlush()
  })
  it('Q_ordinary64KiB_and_shutdown_does_not_release_unfinished_handler',async()=>{
    const h=quotaHarness(),sid=await h.session();const c=h.invoke(sid,1,'tools/call',{padding:60000});expect((await c.result).status).toBe(200)
    c.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(false);expect(h.adapter.requestSnapshot().ordinary).toBe(1)
    c.handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(0)
  })
})

function lifecycleHarness(options:{pending?:boolean;cleanup?:'reject'|'never';standaloneFailure?:boolean;authRecheck?:boolean;detachThrow?:boolean;alreadyClosed?:boolean;authIndividual?:boolean;factoryReject?:boolean;borrow?:boolean;wrapping?:'close-set'|'connect-get'|'close-get'}={}) {
  let time=0,next=0,sidNumber=0,epoch=1,closes=0,transportCloses=0,cleanups=0,standaloneCloses=0,providers=0,factories=0,connects=0,registrations=0,detachCalls=0
  let borrowed:any
  const timers=new Map<number,{at:number;fn:()=>void}>(),factoryGate=admissionDeferred<void>(),cleanupGate=admissionDeferred<void>(),authGate=admissionDeferred<void>()
  const clock={now:()=>time,setTimeout(fn:()=>void,delay:number){const id=++next;timers.set(id,{at:time+delay,fn});return id},clearTimeout(id:unknown){timers.delete(id as number)}}
  const adapter=createActualSessionInitializationTransport<any,any>({
    lifecycleClock:clock,
    authenticate:async e=>{e.auths=(e.auths??0)+1;if(options.authRecheck&&e.auths===2)await authGate.promise;if(options.authIndividual&&e.auths===2)await e.authGate.promise;return {kind:'authorized',epoch:e.epoch??epoch,principal:e.principal??'A'}},
    replay:async(e,request,run)=>{e.request=request;return run(e)},
    factory:async()=>{factories++;if(options.pending)await factoryGate.promise;if(options.factoryReject)throw new Error('private factory failure');if(options.borrow&&borrowed)return borrowed;const owner:any={connect:async()=>{connects++},close:async()=>{closes++}};borrowed=owner;
      if(options.wrapping==='close-set')Object.defineProperty(owner,'close',{value:owner.close,writable:false});
      if(options.wrapping==='connect-get')Object.defineProperty(owner,'connect',{get(){throw new Error('private getter')}});
      if(options.wrapping==='close-get')Object.defineProperty(owner,'close',{get(){throw new Error('private getter')}});
      return owner},
    provider:async(factory,e)=>{providers++;if(!e.sid){const owner=factory(),connection={sessionId:undefined as string|undefined,close:async()=>{transportCloses++},closeStandaloneSSEStream(){standaloneCloses++;if(options.standaloneFailure)throw new Error('private close failure')},closeSSEStream(){}};await owner.connect(connection);connection.sessionId='life-'+(++sidNumber);e.owner=owner;return new Response('{}',{headers:{'mcp-session-id':connection.sessionId}})}return new Response(null,{status:e.method?.startsWith('notifications/')?202:200})},
    adopted:e=>e.owner,handlerFinished:e=>e.handler.promise,
    cleanupSession:async()=>{cleanups++;if(options.cleanup==='reject')throw new Error('private credential');if(options.cleanup==='never')await cleanupGate.promise;return {empty:true}},
  })
  function invoke(sid:string|undefined,id:any,method='tools/call',extra:{http?:string;principal?:string;epoch?:number;target?:any;detachBeforeThrow?:boolean;registration?:string;afterDetach?:()=>void}={}) {
    const authGate=admissionDeferred<void>()
    const handler=admissionDeferred<{finished:true}>(),response=admissionDeferred<{finished:true}>(),body=JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params:{requestId:extra.target}}),bytes=new TextEncoder().encode(body),headers=new Headers({authorization:'Bearer secret','content-length':String(bytes.length),...(sid?{'mcp-session-id':sid}:{})})
    const peer=controlledPeer();if(options.alreadyClosed)peer.close()
    const event={sid,method,handler,authGate,...extra};const input={method:extra.http??'POST',url:'http://unit/life',headers,rawHeaders:[...headers] as Array<[string,string]>,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close()}}),...peer,subscribeClosed:(listener:()=>void):any=>{registrations++;
      if(extra.registration==='throw-before-register')throw new Error('registration unknown');
      const detach=peer.subscribeClosed(listener);
      if(extra.registration?.startsWith('shutdown-'))adapter.shutdown();
      if(extra.registration==='notify-throw'||extra.registration==='notify-success')listener();
      if(extra.registration==='register-throw'||extra.registration==='shutdown-throw')throw new Error('partial registration');
      if(extra.registration==='register-undefined'||extra.registration==='shutdown-invalid')return undefined;
      if(extra.registration==='register-number')return 42;
      return ()=>{detachCalls++;if(extra.detachBeforeThrow||extra.registration==='notify-throw')throw new Error('detach before removal');detach();extra.afterDetach?.();if(options.detachThrow)throw new Error('private detach failure')}},responseFinished:response.promise,terminate(){}}
    return {peer,releaseAuth:()=>authGate.resolve(),result:adapter.handle(event,input),handler:()=>handler.resolve({finished:true}),finish:()=>response.resolve({finished:true}),rejectReceipt:()=>response.reject(new Error('private receipt failure'))}
  }
  return {adapter,invoke,clock,timers,factoryGate,cleanupGate,authGate,setTimeWithoutTimers:(value:number)=>{time=value},setEpoch:(value:number)=>{epoch=value},counts:()=>({closes,transportCloses,cleanups,standaloneCloses,providers,factories,connects,registrations,detachCalls}),
    async advance(ms:number){time+=ms;for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn()}await quotaFlush()},
    async session(){const c=invoke(undefined,0,'initialize');const response=await c.result;c.finish();expect(response.status).toBe(200);return response.headers.get('mcp-session-id')!}}
}

describe('L_get_ttl_lifecycle_pure',()=>{
  it("_detach_removed_then_shutdown_rejects_publication_and_closes_once",async()=>{
    const h=lifecycleHarness();let callbacks=0,removed=-1
    const c=h.invoke(undefined,0,'initialize',{afterDetach:()=>{callbacks++;removed=c.peer.observerCount();h.adapter.shutdown()}})
    const response=await c.result;expect(response.status).toBe(503);expect(response.headers.get('mcp-session-id')).toBeNull();expect(await response.json()).toMatchObject({error:{data:{code:'initialization_revoked'}}})
    expect(callbacks).toBe(1);expect(removed).toBe(0);expect(c.peer.observerCount()).toBe(0);c.finish();await quotaFlush()
    expect(h.counts()).toMatchObject({factories:1,providers:1,connects:1,detachCalls:1,closes:1,transportCloses:1,cleanups:1});expect(h.adapter.snapshot()).toMatchObject({total:0,closing:0,ready:0});expect(h.adapter.requestSnapshot().charged).toBe(0);expect(h.adapter.lifecycleSnapshot()).toEqual({streams:0,timers:0,retained:0});expect(h.adapter.shutdown()).toMatchObject({complete:true,total:0});c.peer.close();await quotaFlush();expect(h.counts().closes).toBe(1)
  })
  it("_detach_removed_then_clock_crosses_deadline_without_timer_rejects_publication",async()=>{
    const h=lifecycleHarness();let callbacks=0,removed=-1
    const c=h.invoke(undefined,0,'initialize',{afterDetach:()=>{callbacks++;removed=c.peer.observerCount();h.setTimeWithoutTimers(5001)}})
    const response=await c.result;expect(response.status).toBe(503);expect(response.headers.get('mcp-session-id')).toBeNull();expect(await response.json()).toMatchObject({error:{data:{code:'initialization_revoked'}}});c.finish();await quotaFlush()
    expect(callbacks).toBe(1);expect(removed).toBe(0);expect(c.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1,detachCalls:1});expect(h.adapter.snapshot().total).toBe(0);expect(h.adapter.requestSnapshot().charged).toBe(0);expect(h.adapter.lifecycleSnapshot()).toEqual({streams:0,timers:0,retained:0});expect(h.adapter.shutdown().complete).toBe(true)
  })
  it("_detach_closes_other_initializing_session_current_still_publishes",async()=>{
    const h=lifecycleHarness({authIndividual:true}),other=h.invoke(undefined,0,'initialize');await quotaFlush();expect(other.peer.observerCount()).toBe(1);let callbacks=0
    const current=h.invoke(undefined,0,'initialize',{afterDetach:()=>{callbacks++;expect(current.peer.observerCount()).toBe(0);other.peer.close()}});await quotaFlush();current.releaseAuth()
    const response=await current.result;expect(response.status).toBe(200);const sid=response.headers.get('mcp-session-id');expect(sid).toBe('life-2');if(!sid)throw new Error('missing current sid');current.finish();other.releaseAuth();expect((await other.result).status).toBe(503);other.finish();await quotaFlush()
    expect(callbacks).toBe(1);expect(other.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1});expect(h.adapter.snapshot()).toMatchObject({ready:1,total:1});const call=h.invoke(sid,1);expect((await call.result).status).toBe(200);call.handler();call.finish();await quotaFlush();h.adapter.shutdown();await quotaFlush();expect(h.adapter.shutdown()).toMatchObject({complete:true,total:0});expect(h.counts()).toMatchObject({closes:2,transportCloses:2,cleanups:2});expect(h.adapter.requestSnapshot().charged).toBe(0);expect(h.adapter.lifecycleSnapshot()).toEqual({streams:0,timers:0,retained:0})
  })

  it.each(['notify-throw','register-throw','register-undefined','register-number','throw-before-register'])("_registration_failure_%s_retains64",async registration=>{
    const h=lifecycleHarness(),peers=[]
    for(let i=0;i<64;i++){const c=h.invoke(undefined,0,'initialize',{registration});expect((await c.result).status).toBe(503);peers.push(c.peer);expect(c.peer.observerCount()).toBe(registration==='throw-before-register'?0:1);expect(h.adapter.snapshot()).toMatchObject({closing:i+1,total:i+1});expect(h.adapter.lifecycleSnapshot().retained).toBe(i+1)}
    const denied=h.invoke(undefined,0,'initialize',{registration});expect((await denied.result).status).toBe(503);expect(denied.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({registrations:64,factories:0,providers:0,connects:0,closes:0,detachCalls:registration==='notify-throw'?64:0});expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:64,total:64});expect(h.adapter.lifecycleSnapshot().timers).toBe(0)
    expect(peers.reduce((n,p)=>n+p.observerCount(),0)).toBe(registration==='throw-before-register'?0:64);for(const peer of peers)peer.close();expect(h.adapter.shutdown().total).toBe(64);expect(h.counts().registrations).toBe(64)
  })
  it("_sync_notify_success_detaches_once_factory_zero",async()=>{
    const h=lifecycleHarness();for(let i=0;i<80;i++){const c=h.invoke(undefined,0,'initialize',{registration:'notify-success'});expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(0);expect(h.adapter.snapshot().total).toBe(0);c.peer.close();c.peer.close()}
    expect(h.counts()).toMatchObject({registrations:80,detachCalls:80,factories:0,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(true)
  })
  it.each(['shutdown-success','shutdown-throw','shutdown-invalid'])("_registration_reentrant_%s",async registration=>{
    const h=lifecycleHarness(),c=h.invoke(undefined,0,'initialize',{registration});expect((await c.result).status).toBe(503);const failed=registration!=='shutdown-success';expect(c.peer.observerCount()).toBe(failed?1:0);expect(h.adapter.shutdown()).toMatchObject({complete:!failed,total:failed?1:0,closing:failed?1:0,accepting:false});expect(h.counts()).toMatchObject({registrations:1,detachCalls:failed?0:1,factories:0,providers:0,closes:0});const denied=h.invoke(undefined,0,'initialize');expect((await denied.result).status).toBe(503);expect(h.counts().registrations).toBe(1);c.peer.close()
  })
  it("_partial_registration_never_acquires_or_closes_foreign_owner",async()=>{
    const h=lifecycleHarness({borrow:true}),sid=await h.session(),c=h.invoke(undefined,0,'initialize',{registration:'register-throw'});expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(1);expect(h.counts()).toMatchObject({factories:1,providers:1,connects:1,closes:0});expect(h.adapter.snapshot()).toMatchObject({ready:1,closing:1,total:2});const call=h.invoke(sid,1);expect((await call.result).status).toBe(200);call.handler();call.finish();const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.adapter.shutdown()).toMatchObject({complete:false,total:1,closing:1});c.peer.close();expect(h.counts().closes).toBe(1)
  })

  it.each(['release','timeout','disconnect'] as const)("_auth_eight_concurrent_ninth_rejected_%s",async mode=>{
    const h=lifecycleHarness({authIndividual:true});const calls=Array.from({length:8},()=>h.invoke(undefined,0,'initialize'))
    await quotaFlush();expect(h.counts()).toMatchObject({factories:8,connects:8,providers:8});expect(h.adapter.snapshot().ready).toBe(8)
    const ninth=h.invoke(undefined,0,'initialize');expect((await ninth.result).status).toBe(503);expect(h.counts()).toMatchObject({factories:8,connects:8,providers:8})
    if(mode==='release'){calls[0]!.releaseAuth();expect((await calls[0]!.result).status).toBe(200);calls[0]!.finish()}
    if(mode==='disconnect'){calls[0]!.peer.close();await quotaFlush();expect(h.counts().closes).toBe(1)}
    if(mode==='timeout'){await h.advance(5000);expect(h.counts().closes).toBe(8)}
    const next=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.counts().factories).toBe(9);expect(h.counts().providers).toBe(9)
    for(const c of [...calls,next]){c.releaseAuth();const response=await c.result;expect(response.status).toBe(mode==='timeout'&&c!==next||mode==='disconnect'&&c===calls[0]?503:200);c.finish();expect(c.peer.observerCount()).toBe(0)}
    h.adapter.shutdown();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)
  })
  it("_factory_reject_detach_before_removal_is_bounded64",async()=>{
    const h=lifecycleHarness({factoryReject:true});const observers=[]
    for(let i=0;i<64;i++){const c=h.invoke(undefined,0,'initialize',{detachBeforeThrow:true});expect((await c.result).status).toBe(503);observers.push(c.peer);expect(c.peer.observerCount()).toBe(1);expect(h.adapter.snapshot()).toMatchObject({closing:i+1,total:i+1})}
    const extra=h.invoke(undefined,0,'initialize',{detachBeforeThrow:true});expect((await extra.result).status).toBe(503);expect(extra.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({factories:64,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(false)
    expect(observers.reduce((n,p)=>n+p.observerCount(),0)).toBe(64);for(const p of observers)p.close();expect(h.adapter.snapshot().total).toBe(64);expect(h.counts().factories).toBe(64)
  })
  it("_factory_reject_successful_detach_and_close_races_once",async()=>{
    for(const mode of ['normal','closed','alreadyclosed']){const h=lifecycleHarness({factoryReject:true,pending:true,alreadyClosed:mode==='alreadyclosed'}),c=h.invoke(undefined,0,'initialize');await quotaFlush();if(mode==='closed'){c.peer.close();c.peer.close()}h.factoryGate.resolve();expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(0);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts()).toMatchObject({factories:mode==='alreadyclosed'?0:1,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(true)}
  })
  it.each([false,true])("_foreign_owner_detach_failure_%s_preserves_first",async fail=>{
    const h=lifecycleHarness({borrow:true}),sid=await h.session(),second=h.invoke(undefined,0,'initialize',{detachBeforeThrow:fail});expect((await second.result).status).toBe(503);expect(second.peer.observerCount()).toBe(fail?1:0);expect(h.counts()).toMatchObject({factories:2,connects:1,providers:1,closes:0});expect(h.adapter.snapshot()).toMatchObject({ready:1,closing:fail?1:0,total:fail?2:1})
    const ordinary=h.invoke(sid,1);expect((await ordinary.result).status).toBe(200);ordinary.handler();ordinary.finish();const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.adapter.snapshot().total).toBe(fail?1:0);expect(h.adapter.shutdown().complete).toBe(!fail);expect(h.counts().closes).toBe(1);second.peer.close()
  })
  it.each(['close-set','connect-get','close-get'] as const)("_owned_public_method_wrapping_failure_%s",async wrapping=>{
    const h=lifecycleHarness({wrapping}),c=h.invoke(undefined,0,'initialize');expect((await c.result).status).toBe(wrapping==='close-get'?503:500);expect(c.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({factories:1,providers:0,closes:wrapping==='close-get'?0:1});expect(h.adapter.snapshot().total).toBe(wrapping==='close-get'?1:0);expect(h.adapter.shutdown().complete).toBe(wrapping!=='close-get')
  })

  it("_deadline_at_publication_when_timer_delayed_during_auth",async()=>{
    const h=lifecycleHarness({authRecheck:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.adapter.snapshot().ready).toBe(1)
    h.setTimeWithoutTimers(5000);h.authGate.resolve();expect((await init.result).status).toBe(503);await quotaFlush()
    expect(h.adapter.snapshot().total).toBe(0);expect(init.peer.observerCount()).toBe(0);expect(h.counts().closes).toBe(1)
  })
  it("_auth_recheck_timer_retires_then_late_auth_never_publishes",async()=>{
    const h=lifecycleHarness({authRecheck:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();await h.advance(5000)
    expect(h.counts().closes).toBe(1);h.authGate.resolve();expect((await init.result).status).toBe(503);expect(init.peer.observerCount()).toBe(0)
  })
  it("_already_closed_no_factory_and_detach_failure_retires",async()=>{
    const h=lifecycleHarness({alreadyClosed:true}),init=h.invoke(undefined,0,'initialize');expect((await init.result).status).toBe(503);expect(h.counts().providers).toBe(0);expect(h.adapter.snapshot().total).toBe(0)
    const b=lifecycleHarness({detachThrow:true}),bad=b.invoke(undefined,0,'initialize');expect((await bad.result).status).toBe(503);await quotaFlush();expect(b.counts().closes).toBe(1);expect(b.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(bad.peer.observerCount()).toBe(0)
  })
  it("_pending_disconnect_late_factory_no_publish",async()=>{
    const h=lifecycleHarness({pending:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();init.peer.close();expect(h.adapter.snapshot().closing).toBe(1)
    h.factoryGate.resolve();expect((await init.result).status).toBe(503);await quotaFlush();expect(h.adapter.snapshot().total).toBe(0);expect(init.peer.observerCount()).toBe(0)
  })
  it("_repeated_initialize_delete_detaches_observers",async()=>{
    const h=lifecycleHarness()
    for(let i=0;i<80;i++){const init=h.invoke(undefined,0,'initialize'),response=await init.result;expect(response.status).toBe(200);expect(init.peer.observerCount()).toBe(0);init.finish();const sid=response.headers.get('mcp-session-id')!;const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)}
  })

  it('L_get_one_eight_identity_and_response_receipt',async()=>{
    const h=lifecycleHarness(),sids:string[]=[],streams:any[]=[];for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8)){const c=h.invoke(sid,undefined,'GET',{http:'GET'});expect((await c.result).status).toBe(200);streams.push(c)}
    expect(h.adapter.lifecycleSnapshot().streams).toBe(8)
    expect((await h.invoke(sids[0],undefined,'GET',{http:'GET'}).result).status).toBe(409)
    expect((await h.invoke(sids[8],undefined,'GET',{http:'GET'}).result).status).toBe(503)
    expect((await h.invoke(sids[0],undefined,'GET',{http:'GET',principal:'B'}).result).status).toBe(404)
    streams[0].finish();await quotaFlush();expect(h.adapter.lifecycleSnapshot().streams).toBe(7)
    const replacement=h.invoke(sids[8],undefined,'GET',{http:'GET'});expect((await replacement.result).status).toBe(200)
    expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    for(const c of streams)c.finish();replacement.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)
  })
  it('L_get_is_independent_of_full_ordinary_and_control',async()=>{
    const h=lifecycleHarness(),sids:string[]=[],calls:any[]=[];for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8))for(let id=1;id<=4;id++){const c=h.invoke(sid,id);await c.result;calls.push(c)}
    for(const sid of sids.slice(0,4))for(let i=0;i<2;i++){const c=h.invoke(sid,undefined,'notifications/cancelled',{target:999});await c.result;calls.push(c)}
    const get=h.invoke(sids[0],undefined,'GET',{http:'GET'});expect((await get.result).status).toBe(200);expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:32,control:8});expect(h.adapter.lifecycleSnapshot().streams).toBe(1)
    for(const c of calls){c.handler();c.finish()}get.finish();await quotaFlush();h.adapter.shutdown();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)
  })
  for(const method of ['GET','notifications/initialized','notifications/cancelled'])it('L_eligible_'+method.replaceAll('/','_')+'_touches_idle',async()=>{
    const h=lifecycleHarness(),sid=await h.session();const rpc=h.invoke(sid,1);await rpc.result
    await h.advance(299999);const c=h.invoke(sid,undefined,method,{http:method==='GET'?'GET':undefined,target:1});expect((await c.result).status).toBe(method==='GET'?200:202);c.finish();rpc.handler();rpc.finish();await quotaFlush()
    await h.advance(1);expect(h.adapter.snapshot().ready).toBe(1);await h.advance(299999);expect(h.adapter.snapshot().total).toBe(0)
  })
  for(const failure of ['close','receipt','never'] as const)it('L_GET_'+failure+'_retains_stream_and_closing',async()=>{
    const h=lifecycleHarness({standaloneFailure:failure==='close'}),sid=await h.session(),get=h.invoke(sid,undefined,'GET',{http:'GET'});expect((await get.result).status).toBe(200)
    if(failure==='close')get.finish();if(failure==='receipt')get.rejectReceipt();await quotaFlush()
    expect(h.adapter.lifecycleSnapshot().streams).toBe(1);expect(h.adapter.shutdown().complete).toBe(false);await quotaFlush();expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.timers.size).toBe(0)
  })
  it('L_idle_before_exact_after_and_session_isolation',async()=>{
    const h=lifecycleHarness(),a=await h.session();await h.advance(100000);const b=await h.session()
    await h.advance(199999);expect(h.adapter.snapshot().ready).toBe(2)
    await h.advance(1);expect(h.adapter.snapshot().ready).toBe(1);expect(h.counts().closes).toBe(1)
    expect((await h.invoke(a,1).result).status).toBe(404)
    await h.advance(1);const c=h.invoke(b,1);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush();h.adapter.shutdown();await quotaFlush()
    expect(h.adapter.snapshot().total).toBe(0);expect(h.timers.size).toBe(0)
  })
  it('L_eligible_activity_extends_idle_but_absolute_is_fixed',async()=>{
    const h=lifecycleHarness(),sid=await h.session()
    for(let id=1;id<=17;id++){await h.advance(100000);const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush()}
    await h.advance(99999);expect(h.adapter.snapshot().ready).toBe(1)
    await h.advance(1);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts().closes).toBe(1)
    expect((await h.invoke(sid,18).result).status).toBe(404)
  })
  it('L_unknown_completed_repeat_and_wrong_identity_do_not_touch',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),active=h.invoke(sid,1);await active.result
    const cancel=h.invoke(sid,undefined,'notifications/cancelled',{target:1});expect((await cancel.result).status).toBe(202);cancel.finish();active.handler();active.finish();await quotaFlush()
    await h.advance(299999)
    for(const target of [1,999]){const c=h.invoke(sid,undefined,'notifications/cancelled',{target});expect((await c.result).status).toBe(202);c.finish()}
    expect((await h.invoke(sid,2,'tools/call',{principal:'B'}).result).status).toBe(404)
    await h.advance(1);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts().closes).toBe(1)
  })
  it('L_epoch_ABA_callback_contract_never_retires_owner',async()=>{
    const h=lifecycleHarness(),sid=await h.session();h.setEpoch(2);expect((await h.invoke(sid,1).result).status).toBe(404);h.setEpoch(3);expect((await h.invoke(sid,1).result).status).toBe(404)
    expect(h.counts().closes).toBe(0);expect(h.adapter.snapshot().ready).toBe(1)
    h.adapter.shutdown();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)
  })
  it('L_pending_expiry_late_factory_cleans_without_publish',async()=>{
    const h=lifecycleHarness({pending:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.adapter.snapshot().pending).toBe(1)
    await h.advance(4999);expect(h.adapter.snapshot().pending).toBe(1);await h.advance(1);expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.adapter.lifecycleSnapshot().timers).toBe(0)
    h.factoryGate.resolve();expect((await init.result).status).toBe(503);init.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.counts().providers).toBe(0);expect(h.adapter.snapshot().total).toBe(0)
  })
  it('L_never_factory_bounded_shutdown_stops_new_admission',async()=>{
    const h=lifecycleHarness({pending:true});for(let i=0;i<8;i++)void h.invoke(undefined,i,'initialize').result
    await quotaFlush();await h.advance(5000);expect(h.adapter.snapshot()).toMatchObject({closing:8,total:8});expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    expect((await h.invoke(undefined,9,'initialize').result).status).toBe(503);expect(h.adapter.snapshot().total).toBe(8)
  })
  it('L_expiry_ordinary_get_receipts_hold_charge_and_late_reconcile',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),rpc=h.invoke(sid,1),get=h.invoke(sid,undefined,'GET',{http:'GET'});await rpc.result;await get.result
    await h.advance(300000);expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1,standaloneCloses:1})
    rpc.finish();get.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(false)
    rpc.handler();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true);expect(h.adapter.requestSnapshot().charged).toBe(0);expect(h.adapter.lifecycleSnapshot()).toEqual({streams:0,timers:0,retained:0})
  })
  for(const failure of ['reject','never'] as const)it('L_cleanup_'+failure+'_retains_charge',async()=>{
    const h=lifecycleHarness({cleanup:failure});await h.session();await h.advance(300000)
    expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    expect(JSON.stringify(h.adapter.lifecycleSnapshot())).not.toContain('secret')
    if(failure==='never'){h.cleanupGate.resolve();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)}
  })
  it('L_delete_expiry_shutdown_once_close_without_self_deadlock',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'})
    await quotaFlush();await h.advance(300000);expect((await del.result).status).toBe(204)
    expect(h.adapter.shutdown().complete).toBe(false);expect(h.adapter.snapshot().total).toBe(1)
    del.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true);expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1})
    expect((await h.invoke(sid,undefined,'DELETE',{http:'DELETE'}).result).status).toBe(404)
  })
})
