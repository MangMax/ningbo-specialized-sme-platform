/** #445: static candidate. Execute only in a separately granted C lane.
 * Import/SDK control must succeed before any baseline RED is admissible.
 * Missing module, skipped lane, or timeout is INFRA/UNRUN, never RED.
 */
import { EventEmitter } from 'node:events'
import type { AnyObjectSchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSessionFrontend, inspectPublicSessionPost, isPublicSessionTarget, ownAllRequests, hasNativeSessionOwnership, createSessionRuntime, acceptsSessionFrame, createCredentialSnapshot } from '../server/utils/mcp-session-runtime'

const finished = () => {
  let resolve!: (receipt: { finished: true }) => void
  return { promise: new Promise<{ finished: true }>(r => { resolve = r }), finish: () => resolve({ finished: true }) }
}

describe('445 independent runtime literals', () => {
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

// These are explicit future lanes, not passing coverage. No product/probe tool is
// registered here until the C import-control grant provides owned dependencies.
describe('445 real consumer controls awaiting execution grant', () => {
  it.todo('C_import_control_pinned_SDK_toolkit_H3_Nitro_from_assigned_installation')
  it.todo('C_local_SDK_cancel_signal_and_full_thunk_receipt_without_send')
  it.todo('C_registered_output_validation_and_unknown_error_send_fallback')
  it.todo('C_source_frontend_proxy_pipeline_disconnect_no_collateral_close')
  it.todo('C_compiled_entry_markers_and_legacy_stateless_zero_effect_guards')
  it.todo('C_three_process_A_B_A_old_sid_never_revives')
})

// Runnable SDK-only controls for the future C grant. They do not claim that the
// Nuxt transform, toolkit virtual modules, or production endpoint were exercised.
describe.skipIf(!['control', 'baseline-red'].includes(process.env.ISSUE445_PHASE ?? ''))('445 SDK controls', () => {
  beforeAll(async () => {
    const installation = await realpath(join(import.meta.dirname, '../node_modules'))
    for (const [specifier, name, version] of [
      ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk', '1.32.1'],
      ['@nuxtjs/mcp-toolkit', '@nuxtjs/mcp-toolkit', '0.24.2'],
      ['nitropack', 'nitropack', '2.13.4'], ['h3', 'h3', '1.15.11'],
    ]) {
      const entry = await realpath(fileURLToPath(import.meta.resolve(specifier!)))
      if (!entry.startsWith(installation + '/')) throw new Error('INFRA: borrowed dependency refused')
      let directory = dirname(entry), found = false
      while (directory.startsWith(installation + '/')) {
        const pkg = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse, () => null)
        if (pkg?.name === name) {
          if (pkg.version !== version) throw new Error('INFRA: dependency version drift')
          found = true; break
        }
        directory = dirname(directory)
      }
      if (!found) throw new Error('INFRA: pinned package owner missing')
    }
  })

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
      if (process.env.ISSUE445_PHASE === 'baseline-red') expect(replyCount).toBe(1)
      else expect(replyCount).toBe(0)
    } finally { released(); await request?.catch(() => {}); await client.close(); await server.close() }
  })
})

// Additional independent negatives. Original 12 test bodies/expectations above
// remain byte-for-byte unchanged; no earlier PASS/FAIL is relabelled.
describe('445 bridge helper negatives', () => {
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

/** Real original toolkit/provider + SDK, through the SAME exported app overlay.
 * Both lanes require a new runtime grant. This function is never run at collection.
 */
async function assertFixtureDependencies() {
  const project = await realpath(join(import.meta.dirname, '..'))
  const installation = await realpath(join(project, 'node_modules'))
  if (!installation.startsWith(project + '/')) throw new Error('INFRA: borrowed installation')
  for (const [name, version] of [['@modelcontextprotocol/sdk','1.32.1'],['@nuxtjs/mcp-toolkit','0.24.2'],['nitropack','2.13.4'],['h3','1.15.11'],['nuxt','4.6.1']]) {
    const directory = await realpath(join(installation, name!))
    if (!directory.startsWith(installation + '/')) throw new Error('INFRA: borrowed package')
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (pkg.name !== name || pkg.version !== version) throw new Error('INFRA: fixture package drift')
  }
}
async function prepareRegisteredThunkFixture(mode: 'source' | 'compiled') {
  await assertFixtureDependencies()
  const { mkdtemp, mkdir, writeFile, symlink, realpath } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { writeFileSync, renameSync } = await import('node:fs')
  const { createNitro, createDevServer, build } = await import('nitropack')
  const { configureSessionVirtuals, installSessionOverlay } = await import('../nuxt.config')
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:net')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'issue445-thunk-')))
  const project = join(import.meta.dirname, '..')
  await symlink(join(project, 'node_modules'), join(directory, 'node_modules'), 'dir')
  await mkdir(join(directory, 'server'), { recursive: true })
  const helper = join(project, 'server/utils/mcp-session-runtime.ts')
  const tk = dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit')))
  const originalProvider = join(tk, 'runtime/server/mcp/providers/node.js')
  const defaultConfig = join(directory, 'default.mjs'), statePath = join(directory, 'state.mjs')
  await writeFile(statePath, `
export let owner; export function created(server){owner??=server.server}
let bodyRelease,hookRelease,bodyGate,hookGate;let entered=0,aborted=0,businessDone=0,hookEntered=0,hookDone=0;
export function control(op){if(op==='hold'){bodyGate=new Promise(r=>bodyRelease=r);hookGate=new Promise(r=>hookRelease=r)}if(op==='body')bodyRelease?.();if(op==='hook')hookRelease?.();return {entered,aborted,businessDone,hookEntered,hookDone}}
export async function probe(_args,extra){entered++;const abort=()=>aborted++;extra.signal.addEventListener('abort',abort,{once:true});try{if(bodyGate)await bodyGate;businessDone++;return {content:[{type:'text',text:'literal-probe'}]}}finally{extra.signal.removeEventListener('abort',abort)}}
export async function called(){hookEntered++;if(hookGate)await hookGate;hookDone++}
`)
  await writeFile(defaultConfig, `import {z} from 'zod';import {probe} from './state.mjs';export const defaultHandler={name:'445-owned-fixture',version:'1',resources:[],prompts:[],tools:['list_enterprises','get_enterprise_detail'].map(name=>({name,inputSchema:{label:z.string().optional()},handler:probe}))};`)
  const plugin = join(directory, 'hooks.mjs')
  await writeFile(plugin, `import {useEvent} from 'nitropack/runtime';import {created,called} from './state.mjs';export default nitro=>{nitro.hooks.hook('mcp:server:created',({server})=>created(server));nitro.hooks.hook('mcp:tool:called',async payload=>{if(payload.event!==useEvent())throw new Error('stale-hook-event');await called()})}`)
  const control = join(directory, 'control.mjs')
  await writeFile(control, `import {eventHandler,getQuery} from 'h3';import {CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';import {sessionRuntime,sessionBindingReady,sessionBindingDiagnostic} from ${JSON.stringify(helper)};import {control,owner} from './state.mjs';export default eventHandler(event=>{const op=getQuery(event).op;if(op==='invalid-output')owner.setRequestHandler(CallToolRequestSchema,async()=>({content:42}));return {...control(op),ready:sessionBindingReady(),bindingDiagnostic:sessionBindingDiagnostic(),runtime:sessionRuntime.snapshot(),observations:sessionRuntime.observations()}})`)
  const audit: unknown[] = [] // Existing bound32 unchanged; atomically persist every callback.
  const responses: unknown[] = [] // At most2048, fixed fixture operations only; no request/credential body.
  const atomic = (name: string, value: unknown) => {
    const target = join(directory, name), temporary = target + '.tmp'
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temporary, target)
  }
  const saveAudit = () => atomic('overlay-graph.json', audit)
  const saveResponse = (value: unknown) => { if (responses.length < 2048) responses.push(value); atomic('startup-responses.json', responses) }
  // Fixture-only public configuration/graph observations; never wrap a resolver.
  const assembly: unknown[] = []
  const pathValue = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 512) throw new Error('fixture-path-observation-limit')
    return value
  }
  const bounded = <T,>(values: T[], limit: number) => {
    if (values.length > limit) throw new Error('fixture-assembly-observation-limit')
    return values
  }
  const matcherValue = (value: unknown): unknown => {
    if (value === undefined) return { kind: 'undefined' }
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return pathValue(value)
    if (typeof value === 'function') return { kind: 'function', name: pathValue(value.name) }
    if (value instanceof RegExp) return { kind: 'regexp', source: pathValue(value.source), flags: value.flags }
    if (Array.isArray(value)) return bounded(value, 128).map(matcherValue)
    return { kind: 'unsupported' }
  }
  const saveAssembly = (value: unknown) => {
    bounded(assembly, 31); assembly.push(value)
    if (Buffer.byteLength(JSON.stringify(assembly)) > 1048576) throw new Error('fixture-assembly-byte-limit')
    atomic('assembly-observations.json', assembly)
  }
  const observeOptions = (stage: string, options: any, config?: any) => saveAssembly({
    stage, paths: Object.fromEntries(['rootDir', 'srcDir', 'workspaceDir', 'buildDir', 'entry'].map(key => [key, pathValue(options[key])])),
    output: Object.fromEntries(['dir', 'serverDir', 'publicDir'].map(key => [key, pathValue(options.output[key])])),
    nodeModulesDirs: bounded(options.nodeModulesDirs, 64).map(pathValue),
    plugins: bounded(options.plugins, 32).map(pathValue),
    handlers: bounded(options.handlers, 32).map((handler: any) => ({ route: handler.route, handler: pathValue(handler.handler) })),
    externals: { inline: matcherValue(options.externals?.inline), external: matcherValue(options.externals?.external), trace: matcherValue(options.externals?.trace) },
    rollup: { external: matcherValue(config?.external), preserveSymlinks: matcherValue(config?.preserveSymlinks) },
  })
  const nitro = await createNitro({ rootDir: directory, srcDir: join(directory, 'server'), dev: mode === 'source', preset: mode === 'source' ? 'nitro-dev' : 'node-server',
    buildDir: join(directory, '.nitro'), output: { dir: join(directory, '.output'), serverDir: join(directory, '.output/server') },
    experimental: { asyncContext: true }, runtimeConfig: { mcpToken: 'fixture-A' },
    externals: { inline: ['@modelcontextprotocol/sdk', '@nuxtjs/mcp-toolkit', defaultConfig, statePath, plugin, control] }, plugins: [plugin],
    handlers: [{ route: '/mcp-session', handler: join(project, 'server/routes/mcp-session.ts') }, { route: '/control', handler: control }],
    virtual: {
      '#nuxt-mcp-toolkit/config.mjs': () => 'export default '+JSON.stringify({ name: '445-fixture', sessions: { enabled: false }, security: {}, defaultHandlerStrategy: 'orphans' }),
      '#nuxt-mcp-toolkit/transport.mjs': () => `export {default} from '${originalProvider}'`,
      '#nuxt-mcp-toolkit/default-handler.mjs': `export {defaultHandler} from ${JSON.stringify(defaultConfig)}`,
      ...Object.fromEntries(['tools','resources','prompts','handlers'].map(name => [`#nuxt-mcp-toolkit/${name}.mjs`, `export const ${name}=[]`])),
    },
  })
  configureSessionVirtuals(nitro)
  observeOptions('configured', nitro.options)
  nitro.hooks.hook('rollup:before', (n, config) => {
    installSessionOverlay(n, config, value => { if (audit.length >= 32) throw new Error('fixture-audit-limit'); audit.push(value); saveAudit() }, { kind: 'component', mount: { baseURL: '/', route: '/mcp-session' } })
    observeOptions('rollup-before', n.options, config)
    config.plugins = [config.plugins, {
      name: '445-owned-public-assembly-observer',
      buildStart(options: any) {
        saveAssembly({ stage: 'rollup-build-start', preserveSymlinks: options.preserveSymlinks })
      },
      generateBundle(this: any, _options: unknown, bundle: Record<string, any>) {
        saveAssembly({ stage: 'generate-bundle', fixtureModules: [defaultConfig, statePath, plugin, control].map(id => {
          const info = this.getModuleInfo(id)
          return { id: pathValue(id), present: info !== null, isExternal: info?.isExternal ?? null }
        }), chunks: bounded(Object.values(bundle).filter(item => item.type === 'chunk'), 8).map(chunk => ({
          fileName: pathValue(chunk.fileName), imports: bounded(chunk.imports, 128).map(pathValue),
          moduleIDs: bounded(Object.keys(chunk.modules), 1024).map(pathValue),
        })) })
      },
    }]
  })
  let child: ReturnType<typeof spawn> | undefined, server: ReturnType<typeof createDevServer> | undefined
  let origin = ''
  try {
    if (mode === 'source') {
      server = createDevServer(nitro)
      const listener = await server.listen(0, { hostname: '127.0.0.1' })
      origin = listener.url.replace(/\/$/, '')
      await build(nitro)
    } else {
      await build(nitro)
      const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r))
      const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('INFRA: no owned port')
      const port = address.port; await new Promise<void>((r, j) => reserve.close(e => e ? j(e) : r()))
      origin = 'http://127.0.0.1:' + port
      const { createWriteStream } = await import('node:fs')
      child = spawn(process.execPath, [join(nitro.options.output.serverDir, 'index.mjs')], { cwd: directory, env: { PATH: process.env.PATH, HOME: process.env.HOME, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), NUXT_MCP_TOKEN: 'fixture-A' }, stdio: ['ignore','pipe','pipe'] })
      child.stdout!.pipe(createWriteStream(join(directory, 'server.stdout.log')))
      child.stderr!.pipe(createWriteStream(join(directory, 'server.stderr.log')))
    }
    saveAudit()
    const observedFetch = async (kind: string, url: string) => {
      try {
        const result = await fetch(url)
        const body = await result.text()
        saveResponse({ sequence: responses.length, kind, status: result.status, contentType: result.headers.get('content-type'), body: body.slice(0, 8192), truncated: body.length > 8192 })
        return { result, body }
      } catch (error) {
        saveResponse({ sequence: responses.length, kind, error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 256) } : { name: 'unknown' } })
        throw error
      }
    }
    const query = async (op = 'stats') => {
      const { result, body } = await observedFetch('control:' + op, origin + '/control?op=' + op)
      if (!result.ok) throw new Error('INFRA: fixture control HTTP ' + result.status)
      return JSON.parse(body)
    }
    // Startup is a control prerequisite, never the behavior RED.
    let live = false
    for (let i = 0; i < 100; i++) {
      try { await observedFetch('prime', origin + '/mcp-session'); if ((await query()).ready) { live = true; break } } catch { /* bounded startup only */ }
      await new Promise(r => setTimeout(r, 100))
    }
    if (!live) { atomic('startup-final.json', { ready: false, lastResponses: responses.slice(-2) }); throw new Error('INFRA: real graph markers not ready') }
    return { directory, origin, query, async close() {
      await query('body'); await query('hook')
      try { await server?.close(); await nitro.close() } finally { saveAudit() }
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('owned fixture did not close')), 65000); child!.once('exit', () => { clearTimeout(timer); resolve() }) })
      }
    } }
  } catch (error) {
    try { await server?.close(); await nitro.close() } finally { saveAudit() }
    if (child && child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
}

for (const mode of ['source', 'compiled'] as const) {
  describe.skipIf(process.env.ISSUE445_PHASE !== 'thunk-' + mode)('445 real overlay ' + mode, () => {
    it('F_registered_thunk_validation_hook_and_cancel_send_zero', async () => {
      await assertFixtureDependencies()
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js')
      const fixture = await prepareRegisteredThunkFixture(mode)
      const client = new Client({ name: '445-real-overlay-client', version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL('/mcp-session', fixture.origin), { requestInit: { headers: { authorization: 'Bearer fixture-A' } } })
      const waitFor = async (predicate: (state: any) => boolean) => {
        for (let i = 0; i < 100; i++) { const state = await fixture.query(); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 10)) }
        throw new Error('guard state not reached')
      }
      try {
        await client.connect(transport)
        expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_enterprise_detail','list_enterprises'])
        expect((await client.callTool({ name: 'get_enterprise_detail', arguments: { label: 'control' } })).content).toEqual([{ type: 'text', text: 'literal-probe' }])
        const initial = await fixture.query()
        expect(initial.observations.entered).toBe(3) // actual initialize + list + call
        expect(initial.observations.settled).toBe(3)
        await fixture.query('hold')
        const controller = new AbortController()
        const call = client.request({ method: 'tools/call', params: { name: 'list_enterprises', arguments: { label: 'held' } } }, CallToolResultSchema, { signal: controller.signal, timeout: 5000 })
        const rejected = call.then(() => 'unexpected-success', () => 'rejected')
        await waitFor(s => s.entered === initial.entered + 1)
        controller.abort(); await waitFor(s => s.aborted === 1)
        await fixture.query('body'); const inHook = await waitFor(s => s.hookEntered === initial.hookEntered + 1)
        expect(inHook.businessDone).toBe(initial.businessDone + 1)
        expect(inHook.runtime.requests).toBe(1)
        expect(inHook.observations.settled).toBe(initial.observations.settled)
        await fixture.query('hook')
        const complete = await waitFor(s => s.runtime.requests === 0)
        expect(await rejected).toBe('rejected')
        expect(complete.observations.settled).toBe(initial.observations.settled + 1)
        expect(complete.observations.resultSends).toBe(initial.observations.resultSends)
        expect(complete.observations.errorSends).toBe(initial.observations.errorSends)
        const beforeSchema = await fixture.query()
        await expect(client.request({ method: 'tools/call', params: { name: 'list_enterprises', arguments: 'invalid-record' } } as any, CallToolResultSchema)).rejects.toThrow()
        const schemaDone = await waitFor(s => s.runtime.requests === 0)
        expect(schemaDone.observations.entered).toBe(beforeSchema.observations.entered + 1)
        expect(schemaDone.observations.settled).toBe(beforeSchema.observations.settled + 1)
        expect(schemaDone.businessDone).toBe(beforeSchema.businessDone)
        const beforeUnknown = await fixture.query()
        await expect(client.request({ method: 'unknown_fixture_method' } as any, CallToolResultSchema)).rejects.toThrow()
        const unknownDone = await waitFor(s => s.runtime.requests === 0)
        expect(unknownDone.observations.entered).toBe(beforeUnknown.observations.entered)
        expect(unknownDone.observations.errorSends).toBe(beforeUnknown.observations.errorSends + 1)
        await fixture.query('invalid-output')
        const beforeInvalid = await fixture.query()
        await expect(client.callTool({ name: 'get_enterprise_detail', arguments: {} })).rejects.toThrow()
        const invalidDone = await waitFor(s => s.runtime.requests === 0)
        expect(invalidDone.observations.entered).toBe(beforeInvalid.observations.entered + 1)
        expect(invalidDone.observations.settled).toBe(beforeInvalid.observations.settled + 1)
        expect(invalidDone.observations.errorSends).toBe(beforeInvalid.observations.errorSends + 1)
      } finally {
        try { await transport.terminateSession() } finally { try { await client.close() } finally { await fixture.close() } }
      }
    }, 180000)
  })
}

// #445 actual-app lanes: static candidates, each needs its own parent runtime grant.
// No top-level native/DB/Nuxt/SDK import; existing 17 cases above stay byte-exact.
const APP445_ENTERPRISE = { enterpriseId: 445001, name: '445隔离企业', uscc: 'SYNTHETIC445', district: '海曙区', city: '宁波市' }
const APP445_WRITE = { relPath: '445-owned.txt', page: 1, expectedVersion: null, markdown: '<!-- page: 1 -->\n445 denied write literal' }
const APP445_OFFICIAL = { id: 1, official: 'latest' }
const APP445_INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '445-raw-owned', version: '1' } } }

async function native445Identity() {
  const { createRequire } = await import('node:module')
  const { createHash } = await import('node:crypto')
  const require = createRequire(import.meta.url)
  const packagePath = await realpath(require.resolve('better-sqlite3/package.json'))
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  if (pkg.version !== '13.0.3') throw new Error('HARNESS: SQLite package drift')
  // Public shipped platform entry, not a forced nativeBinding override.
  const binary = join(dirname(packagePath), 'prebuilds', process.platform + '-' + process.arch + '.node')
  const binarySHA256 = createHash('sha256').update(await readFile(binary)).digest('hex')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(':memory:')
  try {
    expect(db.prepare("select '445-native-control' as literal, sqlite_version() as version").get()).toMatchObject({ literal: '445-native-control', version: expect.any(String) })
    return { execPath: process.execPath, node: process.version, abi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch, packagePath, binary: await realpath(binary), binarySHA256 }
  } finally { db.close() }
}

// Artifact/build receipts are parent-granted files, never a request header or app debug endpoint.
type Artifact445 = { root: string; entry: string; manifestSHA256: string; manifest: any; scopeBound: boolean; verify(): Promise<void> }
type Business445 = { directory: string; dbPath: string; files: string; incoming: string; grantId: string; nonce: string }
type App445Options = { mode?: 'source' | 'compiled'; artifact?: Artifact445; token?: string; label?: 'A1' | 'B2' | 'A3'; sharedBusiness?: Business445; stickyControlNonce?: string }
// Test-owned IPC capability only; no production import, HTTP endpoint or runtime-config mutation.
function sticky445ControlPreload(nonce: string, entry: string): string {
  return String.raw`if(process.argv[1]===${JSON.stringify(entry)}&&typeof process.send==='function'){
const nonce=${JSON.stringify(nonce)};let seq=0,active=true,expected,removeHook,observed=0;
const send=row=>{if(process.connected)process.send({channel:'445-owned-sticky-v1',nonce,...row},()=>{})};
const cleanup=()=>{active=false;expected=undefined;removeHook?.();process.off('message',control);process.off('disconnect',cleanup);process.off('exit',cleanup)};
async function control(message){if(!active||!message||typeof message!=='object'||message.channel!=='445-owned-sticky-v1')return;
if(message.nonce!==nonce||message.op!=='set-token'||message.seq!==seq+1||seq>=2||typeof message.value!=='string'||!/^[0-9a-f]{48}$/.test(message.value))return;
seq++;
try{if(!removeHook){
// These are the EXACT public API export bindings used by the sealed route chunk.
// Both modules have already loaded in this main process before its healthy read.
const {aF:useNitroApp}=await import(${JSON.stringify(new URL('./chunks/nitro/nitro.mjs', 'file://' + entry).href)});
const {az:useRuntimeConfig}=await import(${JSON.stringify(new URL('./chunks/_/current-export-model.mjs', 'file://' + entry).href)});
removeHook=useNitroApp().hooks.hook('afterResponse',event=>{try{
if(event.path?.split('?')[0]!=='/mcp-session'||event.method!=='POST'||!active||observed>=4)return;
// Never populate a cache for the route: require its actual currentCredential read.
const cached=!!event.context.nitro?.runtimeConfig;
const equal=cached&&useRuntimeConfig(event).mcpToken===expected;
send({kind:'runtime-config',seq,cached,currentEqualsApplied:equal});if(++observed===4)cleanup();
}catch{send({kind:'runtime-config',seq,cached:false,currentEqualsApplied:false});cleanup()}});}
expected=message.value;process.env.NUXT_MCP_TOKEN=expected;
send({kind:'ack',seq,applied:process.env.NUXT_MCP_TOKEN===expected});
}catch{send({kind:'ack',seq,applied:false});cleanup()}}
process.on('message',control);process.once('disconnect',cleanup);process.once('exit',cleanup);
}
`
}

function compiled445LoadObserver(artifactRoot: string, loadDirectory: string): string {
  return String.raw`import {registerHooks,createRequire} from 'node:module';import {readFileSync,realpathSync,statSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const artifactRoot=${JSON.stringify(artifactRoot)},loadDirectory=${JSON.stringify(loadDirectory)};const loadFile=loadDirectory+'/'+process.pid+'-'+threadId+'.jsonl';const observerPath=realpathSync(fileURLToPath(import.meta.url));const cache=createRequire(import.meta.url).cache;const seenLoads=new Set();let loadCount=0,loadBytes=0,snapshotCount=0,pendingSnapshot=false,reportCount=0;const reportedNative=new Set();
function loadFault(code){try{writeFileSync(loadFile+'.fault',code,{mode:0o600})}catch{}}
function record445Load(path,stage,loaded,format){const canonical=realpathSync(path);if(!canonical.startsWith(artifactRoot+'/')){if(canonical===observerPath)return;throw Error('foreign-module-boundary')}const key=stage+':'+canonical;if(seenLoads.has(key))return;if(seenLoads.size>=4096||++loadCount>4096)throw Error('observer-count-bound');const size=statSync(canonical).size;if(size>134217728)throw Error('observer-file-bound');seenLoads.add(key);const row={pid:process.pid,ppid:process.ppid,timeOrigin:performance.timeOrigin,threadId,path:canonical,sha256:createHash('sha256').update(readFileSync(canonical)).digest('hex'),stage,loaded,format};const line=JSON.stringify(row)+'\n';loadBytes+=Buffer.byteLength(line);if(loadBytes>2097152)throw Error('observer-byte-bound');appendFileSync(loadFile,line,{mode:0o600});}
registerHooks({load(url,context,next){const result=next(url,context);try{if(url.startsWith('file:'))record445Load(fileURLToPath(url),'hook-load',false,result.format)}catch{loadFault('observer-hook-fault')}return result}});
function capture445CJSNative(){try{if(++snapshotCount>64)throw Error('observer-snapshot-bound');const entries=Object.keys(cache);if(entries.length>8192)throw Error('observer-cache-bound');let newNative=false;for(const path of entries){const entry=cache[path];if(!entry?.loaded)continue;if(!path.startsWith(artifactRoot+'/')){record445Load(path,'cache-boundary-check',true,'require-cache-entry');continue}const native=path.endsWith('.node');record445Load(path,native?'native-cache-loaded':'cjs-cache-loaded',true,native?'addon':'require-cache-entry');if(native&&!reportedNative.has(path)){reportedNative.add(path);newNative=true}}if(newNative){if(++reportCount>8)throw Error('observer-report-bound');const report=process.report.getReport();const shared=report.sharedObjects;if(!Array.isArray(shared)||shared.length>2048)throw Error('observer-shared-object-bound');for(const path of shared)if(typeof path==='string'&&path.startsWith(artifactRoot+'/'))record445Load(path,'native-shared-object',true,'native-shared-object')}}catch{loadFault('observer-cache-or-native-fault')}}
channel('http.server.request.start').subscribe(({response})=>{try{response.once('finish',capture445CJSNative)}catch{loadFault('observer-response-fault')}});
process.on('message',()=>{if(!pendingSnapshot){pendingSnapshot=true;setImmediate(()=>{pendingSnapshot=false;capture445CJSNative()})}});process.on('exit',capture445CJSNative);
`
}

async function compiled445Artifact(): Promise<Artifact445> {
  const fs = await import('node:fs/promises'); const { createHash } = await import('node:crypto'); const { tmpdir } = await import('node:os'); const { resolve, relative, isAbsolute } = await import('node:path')
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const readBound = async (path: string, expected: string) => { const bytes = await fs.readFile(path); if (bytes.length > 16 * 1024 * 1024 || hash(bytes) !== expected) throw new Error('HARNESS: granted receipt bytes'); return JSON.parse(bytes.toString('utf8')) }
  const grant = JSON.parse(await fs.readFile(join(dirname(tmpdir()), 'grant.raw'), 'utf8'))
  const receipt = grant.appArtifactReceipt
  if (!receipt?.manifestPath || !receipt?.buildValidationPath) throw new Error('HARNESS: compiled artifact grant missing, not RED')
  const m = await readBound(receipt.manifestPath, receipt.manifestSHA256), validation = await readBound(receipt.buildValidationPath, receipt.buildValidationSHA256)
  const sourceBytes = await fs.readFile(grant.sourcepins)
  if (hash(sourceBytes) !== grant.sourcepinsSHA256) throw new Error('HARNESS: artifact/source grant mismatch')
  const currentPins = JSON.parse(sourceBytes.toString('utf8'))
  expect(m.kind).toBe('445-actual-nuxt-node-server'); expect(m.projectRoot).toBe(resolve(import.meta.dirname, '..'))
  expect(m.node).toMatchObject({ version: 'v24.22.1', platform: 'darwin', arch: 'arm64' })
  const scopeBound = validation.classification === 'CANDIDATE_445_FIXED_PROFILE_OFFLINE_BOUND'
  if (scopeBound) {
    const accepted = grant.scopeArtifactAcceptance
    if (!accepted || accepted.profileId !== validation.profileId || accepted.manifestSHA256 !== receipt.manifestSHA256 || accepted.scopeValidationSHA256 !== receipt.buildValidationSHA256 || accepted.runtimeObligationSHA256 !== validation.runtimeObligationSHA256) throw new Error('HARNESS: parent scope acceptance missing')
    const obligations = await readBound(receipt.runtimeObligationPath, receipt.runtimeObligationSHA256)
    expect(receipt.runtimeObligationSHA256).toBe(validation.runtimeObligationSHA256)
    expect(obligations.profileId).toBe('445-readonly-direct-node24.22.1-darwin-arm64-no-codemode-v1')
    expect(validation.profileId).toBe(obligations.profileId)
    const sticky = grant.phase === 'app-compiled-sticky'
    const extension = grant.runtimeTestExtension
    if (sticky && extension?.stickyIPC !== true) throw new Error('HARNESS: sticky test capability not parent granted')
    if (!sticky) expect(obligations.allowedPhases).toContain(grant.phase)
    if (extension && (!extension.parentApproved || extension.phase !== grant.phase || extension.baseSourcepinsSHA256 !== validation.currentSourcepinsSHA256)) throw new Error('HARNESS: runtime test extension not parent granted')
    const receiptPins = extension ? await readBound(extension.baseSourcepinsPath, extension.baseSourcepinsSHA256) : currentPins
    if (extension) {
      expect(extension.testPath).toBe('tests/mcp-session-consumer-sdk.test.ts')
      expect(extension.beforeTestSHA256).toBe(receiptPins.files[extension.testPath])
      expect(extension.afterTestSHA256).toBe(currentPins.files[extension.testPath])
      expect(currentPins.files).toEqual({ ...receiptPins.files, [extension.testPath]: extension.afterTestSHA256 })
    }
    if (sticky) {
      const route = await fs.readFile(join(m.outputRoot, 'server/chunks/routes/mcp-session.mjs'), 'utf8')
      const core = await fs.readFile(join(m.outputRoot, 'server/chunks/nitro/nitro.mjs'), 'utf8')
      const model = await fs.readFile(join(m.outputRoot, 'server/chunks/_/current-export-model.mjs'), 'utf8')
      expect(route).toContain('aF as useNitroApp')
      expect(route).toContain("import { az as useRuntimeConfig } from '../_/current-export-model.mjs'")
      expect(core).toContain('useNitroApp as aF')
      expect(model).toContain('useRuntimeConfig as az')

    }
    expect(validation.runtimeExecuted).toBe(false)
    expect(validation.artifactManifestSHA256).toBe(receipt.manifestSHA256)
    expect(obligations.requiredCoreFiles).toEqual(['server/index.mjs', 'server/chunks/nitro/nitro.mjs', 'server/enterprise-read-worker.mjs', 'server/chunks/_/enterprise-read-model.mjs', 'server/chunks/_/current-export-model.mjs'])
    expect(validation.requiredStaticMissing).toBe(0)
    expect(validation.completeBoundedScan).toBe(true)
    const offlineAudit = await readBound(validation.offlineAuditPath, validation.offlineAuditSHA256)
    const classified = await readBound(validation.classificationPath, validation.classificationSHA256)
    const profileProof = await readBound(validation.profileProofPath, validation.profileProofSHA256)
    expect(offlineAudit.fault).toBe(null)
    expect(offlineAudit.classification).toBe('COMPLETE_BOUNDED_SCAN_REQUIRES_SCOPE_CLASSIFICATION')
    expect(classified.blockingRequiredEdges).toEqual([])
    expect(classified.completeBoundedScan).toBe(true)
    expect(profileProof.handlerExperimentalCodeMode).toBe('absent => undefined')
    expect(profileProof.namedHandlersCount).toBe(0)
    expect(profileProof.compiledSHA256).toBe(m.inventory['server/chunks/nitro/nitro.mjs'].sha256)

    expect(validation.artifactSourcepinsSHA256).toBe('0073b3f240728d004916d00643208bc31d334431ac69b066db6a22cc2dfeab20')
    expect(m.sourcepinsSHA256).toBe(validation.artifactSourcepinsSHA256)
    expect(m.runtimeObligationSHA256).toBe(validation.runtimeObligationSHA256)
    const delta = validation.runtimeOnlySourceDelta
    expect(delta.path).toBe('tests/mcp-session-consumer-sdk.test.ts')
    expect(receiptPins.files[delta.path]).toBe(delta.afterSHA256)
    expect(m.sourceHashes[delta.path]).toBe(delta.beforeSHA256)
    expect(m.sourceHashes).toEqual({ ...receiptPins.files, [delta.path]: delta.beforeSHA256 })
    expect(validation.currentSourcepinsSHA256).toBe(extension ? extension.baseSourcepinsSHA256 : grant.sourcepinsSHA256)
    expect(validation.generatedAfterSHA256).toBe(grant.generatedPins.sha256)
    const nativeCLI = await readBound(validation.nativeCLIReceiptPath, validation.nativeCLIReceiptSHA256)
    expect(nativeCLI).toMatchObject({ exit: 0, signal: null, rawDiagnosticsClean: true })
    const originalBuild = await readBound(validation.runnerResultPath, validation.runnerResultSHA256)
    expect(originalBuild.status).toBe('STOP'); expect(originalBuild.release.result).toBe('FREE')
    expect(originalBuild.steps.at(-1)).toMatchObject({ exit: 1, signal: null })
    expect(validation.originalWrapperFailureRetained).toBe(true)
    expect(validation.sameGrantFREE).toBe(true)
  }
  else {
    if (m.sourcepinsSHA256 !== grant.sourcepinsSHA256) throw new Error('HARNESS: artifact/source grant mismatch')
    expect(m.sourceHashes).toEqual(currentPins.files)
    expect(validation.classification).toBe('PASS_445_ACTUAL_BUILD_BINDING'); expect(validation.artifactManifestSHA256).toBe(receipt.manifestSHA256)
    expect(validation.sourcepinsSHA256).toBe(grant.sourcepinsSHA256); expect(validation.runtimeExecuted).toBe(false)
    for (const key of ['ordinaryNuxtBuildExit0', 'rawDiagnosticsClean', 'pluginLoadsBound', 'fourEntriesBound', 'modelChunksBound', 'nativeClosureBound', 'sourceMapOwnersBound', 'entryTransformCount2', 'profileDirectNode', 'sourceAndGeneratedUnchanged', 'sameGrantFREE']) expect(validation.checks?.[key], key).toBe(true)
    const buildResult = await readBound(validation.runnerResultPath, validation.runnerResultSHA256)
    expect(buildResult.status).toBe('EXIT_REQUIRES_NATIVE_VALIDATION'); expect(buildResult.release.result).toBe('FREE'); expect(buildResult.steps.at(-1)).toMatchObject({ exit: 0, signal: null, naturalObservedClose: true })
  }
  expect(m.entryTransform).toMatchObject({ count: 2, sourceSHA256: 'de34cd965af3b45c8a108cef1dcb0aa70fa864f44dbd5b5e92625c1e44d66d7c', profile: 'direct-node', sourceFrontendRequired: false, publicInstalled: true })
  expect(m.registeredProtocol).toMatchObject({ count: 1, sourceSHA256: '7ea9524fcde13f9bcb7ce4d1867fd28c7844b6311b43e3a816bb019a3b61e445' })
  expect(m.factoryCurrentEvent.count).toBe(1)
  expect(m.entries).toEqual(['server/index.mjs', 'server/enterprise-read-worker.mjs', 'server/import-execution-worker.mjs', 'server/current-export-worker.mjs'])
  for (const name of ['enterprise-read-model', 'import-execution-model', 'current-export-model']) expect(m.modelChunks.some((path: string) => path.includes(name))).toBe(true)
  expect(m.nativeClosure.some((path: string) => path.endsWith('/better-sqlite3/prebuilds/darwin-arm64.node'))).toBe(true)
  const root = await fs.realpath(m.outputRoot)
  if (root !== m.outputRoot || !root.startsWith('/private/tmp/') || root === resolve(import.meta.dirname, '../.output')) throw new Error('HARNESS: artifact root ownership')
  const verify = async () => {
    const seen: string[] = []; let total = 0
    const walk = async (directory: string) => { for (const ent of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, ent.name), rel = relative(root, path)
      if (seen.length > 50000 || isAbsolute(rel) || rel.split('/').includes('..')) throw new Error('HARNESS: artifact inventory bound')
      if (ent.isDirectory()) await walk(path)
      else {
        seen.push(rel); const bound = m.inventory[rel]; if (!bound) throw new Error('HARNESS: unbound artifact file')
        if (ent.isSymbolicLink()) { expect(bound.kind).toBe('symlink'); expect(await fs.readlink(path)).toBe(bound.target); if (!(await fs.realpath(path)).startsWith(root + '/')) throw new Error('HARNESS: artifact symlink escapes closure') }
        else { const st = await fs.stat(path); total += st.size; if (st.size > 128 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024) throw new Error('HARNESS: artifact bytes bound'); expect(bound.kind).toBe('file'); expect(hash(await fs.readFile(path))).toBe(bound.sha256) }
      }
    } }
    await walk(root); expect(seen.sort()).toEqual(Object.keys(m.inventory).sort())
    for (const [path, expected] of Object.entries(currentPins.files) as [string, string][]) expect(hash(await fs.readFile(join(m.projectRoot, path)))).toBe(expected)
  }
  await verify()
  return { root, entry: join(root, 'server/index.mjs'), manifestSHA256: receipt.manifestSHA256, manifest: m, scopeBound, verify }
}
async function fresh445FixtureDB(dbPath: string) {
  const { initializeDb } = await import('../db/client')
  return initializeDb({ dbPath, create: true })
}

async function start445ActualApp(options: App445Options = {}) {
  const assignedNativeIdentity = await native445Identity() // Guard native loading separately; never install/rebuild.
  const fs = await import('node:fs/promises')
  const sync = await import('node:fs')
  const { createHash, randomBytes } = await import('node:crypto')
  const { tmpdir } = await import('node:os')
  const { resolve } = await import('node:path')
  const { spawnOwnedChild, reserveLoopbackPort, stopOwnedChild, waitForHttp } = await import('./helpers/isolated-local-services.mjs')
  const project = resolve(import.meta.dirname, '..')
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/i445-'))
  const grantDirectory = dirname(tmpdir())
  const grant = JSON.parse(await fs.readFile(join(grantDirectory, 'grant.raw'), 'utf8'))
  if (options.stickyControlNonce && (options.mode !== 'compiled' || options.stickyControlNonce !== grant.nonce)) throw new Error('HARNESS: sticky IPC grant binding')
  const ownership = { directory, mode: (await fs.stat(directory)).mode & 0o777, grantId: grant.grantId, nonce: grant.nonce, grantRoot: grant.root }
  await fs.writeFile(join(grantDirectory, options.label ? 'owned-app-root-' + options.label + '.json' : 'owned-app-root.json'), JSON.stringify(ownership, null, 2), { flag: 'wx', mode: 0o600 })
  if (options.mode === 'compiled' && !options.artifact) throw new Error('HARNESS: compiled mode requires prebuilt artifact')
  const shared = options.sharedBusiness
  if (shared && (shared.grantId !== grant.grantId || shared.nonce !== grant.nonce || await fs.realpath(shared.directory) !== shared.directory || !shared.directory.startsWith('/private/tmp/i445-') || shared.dbPath !== join(shared.directory, 'business.sqlite') || shared.files !== join(shared.directory, 'files') || shared.incoming !== join(shared.directory, 'incoming'))) throw new Error('HARNESS: shared business ownership')
  const buildDir = options.mode === 'compiled' ? options.artifact!.root : join(directory, 'nuxt'), files = shared?.files ?? join(directory, 'files'), incoming = shared?.incoming ?? join(directory, 'incoming')
  if (!shared) { await fs.mkdir(files); await fs.mkdir(incoming) }
  else { if (await fs.realpath(files) !== files || await fs.realpath(incoming) !== incoming) throw new Error('HARNESS: shared business path drift') }
  await fs.mkdir(join(directory, 'diagnostics')); await fs.mkdir(join(directory, 'lifecycle')); await fs.mkdir(join(directory, 'frontend')); if (options.mode === 'compiled') await fs.mkdir(join(directory, 'artifact-loads'))
  await fs.mkdir(join(directory, 'tmp'))
  const atomic = (name: string, value: unknown) => {
    const raw = JSON.stringify(value, null, 2)
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('HARNESS: app audit byte bound')
    const path = join(directory, name); sync.writeFileSync(path + '.tmp', raw, { mode: 0o600 }); sync.renameSync(path + '.tmp', path)
  }
  if (options.mode === 'compiled') atomic('parent-native-identity.json', assignedNativeIdentity)
  const receipt: Record<string, unknown>[] = []
  const record = (value: Record<string, unknown>) => { if (receipt.length >= 128) throw new Error('HARNESS: app receipt bound'); receipt.push(value); atomic('receipts.json', receipt) }
  const token = options.token ?? randomBytes(24).toString('hex') // Memory/env only, never persisted.
  const credentialRedactions = [token] // At most A/B, memory only; protects new sticky logs too.
  const dotenv = join(directory, 'empty.env'); await fs.writeFile(dotenv, '')
  for (const name of ['curated.json', 'reconcile.json']) await fs.writeFile(join(directory, name), '{}')
  const businessBytes = Buffer.from('445 business file literal\n'); if (!shared) await fs.writeFile(join(files, '445-owned.txt'), businessBytes); else expect(await fs.readFile(join(files, '445-owned.txt'))).toEqual(businessBytes)
  const { useDb, schema } = await import('../db')
  const { initializeDb } = await import('../db/client')
  const dbPath = shared?.dbPath ?? join(directory, 'business.sqlite')
  const db = options.mode === 'compiled' ? await fresh445FixtureDB(dbPath)
    : shared ? useDb({ dbPath })
      : initializeDb({ dbPath, create: true })
  const businessState: Business445 = shared ?? { directory, dbPath, files, incoming, grantId: grant.grantId, nonce: grant.nonce }
  let child: ReturnType<typeof spawnOwnedChild> | undefined
  let childExitReceipt: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; spawnError?: boolean } | undefined
  let childExit: Promise<void> | undefined
  const stickyConfigRows: { seq: number; cached: boolean; currentEqualsApplied: boolean }[] = []
  let stickyConfigCount = 0, stickyConfigNotify: (() => void) | undefined
  const sockets = new Set<import('node:net').Socket>()
  let stopped = false, logBytes = 0, logFault: Error | undefined, outputTail = ''
  try {
    const journal = JSON.parse(await fs.readFile(join(project, 'db/migrations/meta/_journal.json'), 'utf8'))
    expect(db.$client.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({ n: journal.entries.length })
    if (!shared) { db.insert(schema.enterprise).values({ id: APP445_ENTERPRISE.enterpriseId, name: APP445_ENTERPRISE.name, nameNorm: APP445_ENTERPRISE.name, usccNorm: APP445_ENTERPRISE.uscc, district: APP445_ENTERPRISE.district, city: APP445_ENTERPRISE.city }).run()
    db.insert(schema.storedFile).values({ id: 445002, relPath: '445-owned.txt', filename: '445-owned.txt', ext: '.txt', bytes: businessBytes.length, sha256: createHash('sha256').update(businessBytes).digest('hex'), createdAt: '2026-10-31T00:00:00Z' }).run() }
    else expect(db.$client.prepare('select id,name from enterprise where id=445001').get()).toEqual({ id: 445001, name: APP445_ENTERPRISE.name })
    // Test-owned public diagnostics only: no prototype patches, raw values, bodies or sid.
    const preload = join(directory, 'http-observe.mjs')
    await fs.writeFile(preload, `import {channel} from 'node:diagnostics_channel';import {appendFileSync,writeFileSync,renameSync} from 'node:fs';import {threadId} from 'node:worker_threads';import {Socket} from 'node:net';
${options.mode === 'compiled' ? compiled445LoadObserver(options.artifact!.root, join(directory, 'artifact-loads')) : ''}
${options.stickyControlNonce ? sticky445ControlPreload(options.stickyControlNonce, options.artifact!.entry) : ''}
const file=${JSON.stringify(join(directory, 'diagnostics'))}+'/'+process.pid+'-'+threadId+'.jsonl';let n=0,next=0;const sockets=new WeakMap();
function emit(row){if(n++>=256){if(n===257)appendFileSync(file,JSON.stringify({pid:process.pid,threadId,kind:'diagnostic-overflow'})+'\\n',{mode:0o600});return}appendFileSync(file,JSON.stringify({pid:process.pid,threadId,...row})+'\\n',{mode:0o600})}
channel('http.server.request.start').subscribe(({request:q,response:r})=>{try{const path=new URL(q.url,'http://owned').pathname;if(!['/mcp-session','/mcp','/api/health'].includes(path))return;let socket=sockets.get(q.socket);if(!socket){socket=++next;sockets.set(q.socket,socket)}const id=n;const names=q.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase());emit({kind:'start',id,socket,path,method:q.method,nativeSocket:q.socket instanceof Socket,localPort:q.socket.localPort??null,cl:names.filter(x=>x==='content-length').length,te:names.includes('transfer-encoding'),encoded:names.includes('content-encoding')});q.once('aborted',()=>emit({kind:'aborted',id,socket,path}));r.once('finish',()=>emit({kind:'finish',id,socket,path,status:r.statusCode}));r.once('close',()=>emit({kind:'close',id,socket,path,finished:r.writableFinished}))}catch{emit({kind:'diagnostic-fault'})}});

const frontFile=file.replace('/diagnostics/','/frontend/').replace(/\\.jsonl$/,'.json');const frontRows=[];
channel('ningbo.mcp-session.445.frontend.v1').subscribe(data=>{try{if(frontRows.length>=64)return;const row={pid:process.pid,threadId,stage:['installed','install-refused','registered','app-installed','app-entered','refusal-end','overflow'].includes(data?.stage)?data.stage:'overflow'};for(const key of ['owned','session','ended','singleFunction','onceWrapper','previousPresent','versionEqual','mountEqual','wrappedEqual'])if(typeof data[key]==='boolean')row[key]=data[key];if(Number.isInteger(data.status)&&data.status>=100&&data.status<=599)row.status=data.status;if(['pin-false','request-listener-count','once-wrapper','previous-version','mount','wrapped-mismatch'].includes(data.reason))row.reason=data.reason;if(Number.isInteger(data.listenerCount)&&data.listenerCount>=0&&data.listenerCount<=65535)row.listenerCount=data.listenerCount;frontRows.push(row);const raw=JSON.stringify(frontRows,null,2);if(Buffer.byteLength(raw)>16384)throw 0;writeFileSync(frontFile+'.tmp',raw,{mode:0o600});renameSync(frontFile+'.tmp',frontFile)}catch{try{writeFileSync(frontFile+'.fault',JSON.stringify({observerFault:true}),{mode:0o600})}catch{}}});

const lifeFile=file.replace('/diagnostics/','/lifecycle/').replace(/\\.jsonl$/,'.json');const lifeRows=[];const lifeCounts=new Map();let lifeOverflow=false;
const lifeStages=new Set(['route','replay','handle','factory-start','candidate','toolkit-return','toolkit-error','provider-entry','provider-response','provider-error','connect','connected','owner-close','owner-closed','transport-closed','adopted','init-receipt','init-entered','init-settled','init-end','receipt-wait','receipt-done','adapter-response','cleanup','overflow']);
const lifeKeys=['owner','response','sid','sidEqual','adopted','receipt','initEntered','initSettled','sameCandidate','currentAvailable','currentEqual','sessionEvent','authPresent','authorized','singleCL','hasTE','replay','complete','observerFault'];
channel('ningbo.mcp-session.445.lifecycle.v1').subscribe(data=>{try{if(lifeOverflow)return;const id=Number.isInteger(data?.attempt)&&data.attempt>=0&&data.attempt<=256?data.attempt:0;const count=lifeCounts.get(id)||0;let row={pid:process.pid,threadId,seq:lifeRows.length+1,attempt:id,stage:lifeStages.has(data?.stage)?data.stage:'overflow'};if(lifeRows.length>=255||count>=63||row.stage==='overflow'){row.stage='overflow';lifeOverflow=true}else{for(const key of lifeKeys)if(typeof data[key]==='boolean')row[key]=data[key];if(Number.isInteger(data.status)&&data.status>=100&&data.status<=599)row.status=data.status;if(['Error','TypeError','RangeError','SyntaxError','AbortError','other'].includes(data.errorName))row.errorName=data.errorName;if(['ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_HTTP_HEADERS_SENT','initialization_closed','candidate_ownership_missing','other'].includes(data.errorCode))row.errorCode=data.errorCode}lifeCounts.set(id,count+1);lifeRows.push(row);const raw=JSON.stringify(lifeRows,null,2);if(Buffer.byteLength(raw)>262144)throw 0;writeFileSync(lifeFile+'.tmp',raw,{mode:0o600});renameSync(lifeFile+'.tmp',lifeFile)}catch{try{writeFileSync(lifeFile+'.fault',JSON.stringify({observerFault:true}),{mode:0o600})}catch{}}});

`)
    const port = await reserveLoopbackPort(0)
    if (port === 3480) throw new Error('HARNESS: forbidden port')
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH']) if (process.env[key]) env[key] = process.env[key]
    Object.assign(env, { CI: '1', NUXT_TELEMETRY_DISABLED: '1', PNPM_CONFIG_OFFLINE: 'true', npm_config_ignore_scripts: 'true', NODE_OPTIONS: '--import=' + preload,
      TMPDIR: join(directory, 'tmp'), NUXT_BUILD_DIR: buildDir, NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: files, NUXT_INCOMING_DIR: incoming,
      NUXT_LOG_DIR: join(directory, 'logs'), NUXT_CURATED_PATH: join(directory, 'curated.json'), NUXT_RECONCILE_PATH: join(directory, 'reconcile.json'), NUXT_MCP_TOKEN: token, NUXT_API_TOKEN: token })
    if (options.mode === 'compiled') Object.assign(env, { NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' })
    const argv = options.mode === 'compiled' ? [options.artifact!.entry] : [join(project, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--dotenv', dotenv]
    atomic('launch.json', { cwd: project, execPath: process.execPath, argv, envKeys: Object.keys(env).sort(), dbPath, files, incoming, buildDir, migrations: journal.entries.length, ownership })
    child = spawnOwnedChild(process.execPath, argv, { cwd: project, env, stdio: options.stickyControlNonce ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] })
    if (options.stickyControlNonce) {
      const observeSticky = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('channel' in message) || message.channel !== '445-owned-sticky-v1') return
        const row = message as { nonce?: unknown; kind?: unknown; seq?: unknown; cached?: unknown; currentEqualsApplied?: unknown }
        if (row.nonce !== options.stickyControlNonce || row.kind !== 'runtime-config') return
        if (++stickyConfigCount > 4 || ![1, 2].includes(Number(row.seq)) || typeof row.cached !== 'boolean' || typeof row.currentEqualsApplied !== 'boolean') { logFault ??= new Error('HARNESS: sticky witness bound'); stickyConfigNotify?.(); return }
        stickyConfigRows.push({ seq: Number(row.seq), cached: row.cached, currentEqualsApplied: row.currentEqualsApplied }); stickyConfigNotify?.()
      }
      child.on('message', observeSticky)
      child.once('exit', () => { child?.off('message', observeSticky); stickyConfigNotify?.() })
      child.once('disconnect', () => { child?.off('message', observeSticky); stickyConfigNotify?.() })
    }
    childExit = new Promise(resolve => {
      child!.once('exit', (exitCode, signalCode) => { childExitReceipt = { pid: child!.pid, exitCode, signalCode }; resolve() })
      child!.once('error', () => { childExitReceipt = { pid: child!.pid, spawnError: true }; resolve() })
    })
    for (const stream of [child.stdout!, child.stderr!]) {
      let pending = ''
      const saveLine = (line: string) => {
        const safe = /authorization|x-mcp-token|mcp-session-id|sessionId/i.test(line) ? '[sensitive-log-line-redacted]\n'
          : credentialRedactions.reduce((safe, credential) => safe.replaceAll(credential, '[owned-credential]'), line).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[opaque-id]')
        logBytes += Buffer.byteLength(safe); outputTail = (outputTail + safe).slice(-16000)
        if (logBytes > 8 * 1024 * 1024) { logFault ??= new Error('HARNESS: Nuxt log limit'); child?.kill('SIGTERM'); return }
        sync.appendFileSync(join(directory, 'nuxt.log'), safe, { mode: 0o600 })
      }
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        pending += chunk
        if (pending.length > 65536) { logFault ??= new Error('HARNESS: Nuxt log line limit'); child?.kill('SIGTERM'); pending = ''; return }
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) { saveLine(pending.slice(0, end + 1)); pending = pending.slice(end + 1) }
      })
      stream.once('end', () => { if (pending) saveLine(pending) })
    }
    const base = 'http://127.0.0.1:' + port
    // Same exact-address rule as the repository launcher; never follow CLI fallback.
    let announced = false
    for (let i = 0; i < 600; i++) {
      if (logFault) throw logFault
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('HARNESS: Nuxt exited before listener')
      const match = [...outputTail.matchAll(options.mode === 'compiled' ? /Listening on (https?:\/\/[^\s]+)/g : /Local:\s+(https?:\/\/[^\s]+)/g)].at(-1)
      if (match) {
        const address = new URL(match[1]!)
        if (address.hostname !== '127.0.0.1' || Number(address.port) !== port) throw new Error('HARNESS: Nuxt listener fallback refused')
        announced = true; break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!announced) throw new Error('HARNESS: no owned Nuxt listener announcement')
    const health = await waitForHttp(base + '/api/health', { child, timeoutMs: 90000 })
    expect(await health.json()).toMatchObject({ recordCount: 0 })
    const live = () => { if (logFault) throw logFault; if (child!.exitCode !== null || child!.signalCode !== null) throw new Error('HARNESS: actual Nuxt exited') }
    async function snapshot() {
      const tables = db.$client.prepare("select name,sql from sqlite_master where type='table' order by name").all() as { name: string; sql: string }[]
      if (tables.length > 256) throw new Error('HARNESS: table inventory bound')
      const hashes = tables.map(table => {
        const rows = db.$client.prepare('select * from "' + table.name.replaceAll('"', '""') + '"').all()
        if (rows.length > 10000) throw new Error('HARNESS: row inventory bound')
        const text = JSON.stringify(rows.map(row => JSON.stringify(row)).sort())
        if (Buffer.byteLength(text) > 1048576) throw new Error('HARNESS: logical DB bound')
        return { table: table.name, schema: table.sql, sha256: createHash('sha256').update(text).digest('hex') }
      })
      const fileRows: unknown[] = []
      async function walk(root: string, path = root) {
        for (const item of await fs.readdir(path, { withFileTypes: true })) {
          if (fileRows.length >= 256 || item.isSymbolicLink()) throw new Error('HARNESS: business file bound/symlink')
          const name = join(path, item.name)
          if (item.isDirectory()) await walk(root, name)
          else { const bytes = await fs.readFile(name); if (bytes.length > 1048576) throw new Error('HARNESS: business file byte bound'); fileRows.push({ root: root === files ? 'files' : 'incoming', path: name.slice(root.length + 1), sha256: createHash('sha256').update(bytes).digest('hex') }) }
        }
      }
      await walk(files); await walk(incoming)
      return { database: hashes, files: fileRows }
    }
    async function boundedBody(response: Response) {
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1048576) { await reader.cancel(); throw new Error('HARNESS: response bound') } chunks.push(part.value) } } finally { reader.releaseLock() }
      return Buffer.concat(chunks).toString('utf8')
    }
    async function rpc(path: '/mcp' | '/mcp-session', frame: unknown, headers: Record<string, string> = {}) {
      live(); const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(frame), signal: AbortSignal.timeout(15000) })
      const text = await boundedBody(response)
      const parsed = text.startsWith('data:') || text.startsWith('event:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())).find(value => value.result || value.error) : JSON.parse(text)
      record({ kind: 'rpc', path, status: response.status, code: parsed?.error?.code ?? null })
      return { response, body: parsed }
    }
    async function sdk(path: '/mcp' | '/mcp-session', authorized = false) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: '445-actual-app', version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(path, base), {
        requestInit: { headers: authorized ? { authorization: 'Bearer ' + token } : {} },
        fetch: (async (input: any, init: any) => {
          const response = await fetch(input, init)
          record({ kind: 'sdk-http', path, method: init?.method ?? 'GET', status: response.status, sessionHeader: response.headers.has('mcp-session-id') })
          return response
        }) as typeof fetch,
      })
      try { await client.connect(transport); return { client, transport, async close() {
        const start = receipt.length
        try { if (path === '/mcp-session') {
          await transport.terminateSession()
          expect(receipt.slice(start).some(row => row.kind === 'sdk-http' && row.method === 'DELETE' && row.status === 204)).toBe(true)
        } } finally { await client.close() }
      } } }
      catch (error) { await client.close(); throw error }
    }
    async function diagnostics() {
      const names = await fs.readdir(join(directory, 'diagnostics')); if (names.length > 32) throw new Error('HARNESS: diagnostic process bound')
      const events: any[] = []
      for (const name of names.sort()) { const raw = await fs.readFile(join(directory, 'diagnostics', name), 'utf8'); if (Buffer.byteLength(raw) > 65536) throw new Error('HARNESS: diagnostic bytes'); events.push(...raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) }
      expect(events.some(row => ['diagnostic-fault', 'diagnostic-overflow'].includes(row.kind))).toBe(false)
      return events
    }
    async function provenance() {
      if (options.mode === 'compiled') {
        await options.artifact!.verify()
        const events = await diagnostics(), starts = events.filter(row => row.kind === 'start' && row.path === '/mcp-session')
        expect(starts.length).toBeGreaterThan(0); expect(new Set(starts.map(row => row.pid + ':' + row.threadId)).size).toBe(1)
        expect(starts.every(row => row.pid === child!.pid && row.threadId === 0 && row.nativeSocket && row.localPort === port)).toBe(true)
        for (const path of ['server/mcp/index.ts', 'server/mcp/tools/list_enterprises.ts', 'server/mcp/tools/get_enterprise_detail.ts', 'server/routes/mcp-session.ts', 'server/utils/mcp-session-runtime.ts']) expect(options.artifact!.manifest.sourceMapOwners[path]?.length).toBeGreaterThan(0)
        const loadNames = await fs.readdir(join(directory, 'artifact-loads')); if (loadNames.length > 32 || loadNames.some(name => name.endsWith('.fault'))) throw new Error('HARNESS: artifact load observation fault')
        const loads: { path: string; sha256: string; pid: number; threadId: number; overflow?: boolean }[] = []
        for (const name of loadNames.filter(name => name.endsWith('.jsonl'))) { const raw = await fs.readFile(join(directory, 'artifact-loads', name), 'utf8'); if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('HARNESS: artifact load log bytes'); loads.push(...raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) }
        expect(loads.some(row => row.overflow)).toBe(false)
        const native = loads.filter(row => row.path.endsWith('/better-sqlite3/prebuilds/darwin-arm64.node'))
        expect(native.length, 'actual shipped artifact native load, not parent preflight').toBeGreaterThan(0)
        for (const row of native) expect(row.sha256).toBe(options.artifact!.manifest.inventory[row.path.slice(options.artifact!.root.length + 1)].sha256)
        expect(loads.some(row => row.path === join(options.artifact!.root, 'server/enterprise-read-worker.mjs'))).toBe(true)
        if (options.artifact!.scopeBound) {
          const main = child!.pid!
          const workerRows = loads.filter(row => row.path === join(options.artifact!.root, 'server/enterprise-read-worker.mjs'))
          const workerPids = [...new Set(workerRows.map(row => row.pid))]
          expect(workerPids).toHaveLength(1); expect(workerPids[0]).not.toBe(main)
          const scopedLoads = loads as (typeof loads[number] & { ppid?: number; stage?: string; loaded?: boolean })[]
          for (const row of scopedLoads) {
            const bound = options.artifact!.manifest.inventory[row.path.slice(options.artifact!.root.length + 1)]
            expect(bound?.kind).toBe('file'); expect(row.sha256).toBe(bound.sha256)
          }
          for (const suffix of ['server/index.mjs', 'server/chunks/nitro/nitro.mjs']) expect(scopedLoads.some(row => row.pid === main && row.path === join(options.artifact!.root, suffix))).toBe(true)
          for (const pid of [main, workerPids[0]!]) {
            expect(scopedLoads.some(row => row.pid === pid && row.path.endsWith('/drizzle-orm/better-sqlite3/index.js'))).toBe(true)
            expect(scopedLoads.some(row => row.pid === pid && row.loaded === true && row.stage === 'cjs-cache-loaded' && row.path.endsWith('/better-sqlite3/lib/index.js'))).toBe(true)
            for (const stage of ['native-cache-loaded', 'native-shared-object']) expect(scopedLoads.some(row => row.pid === pid && row.loaded === true && row.stage === stage && row.path.endsWith('/better-sqlite3/prebuilds/darwin-arm64.node'))).toBe(true)
          }
          expect(scopedLoads.filter(row => row.pid === workerPids[0]).every(row => row.ppid === main)).toBe(true)
          for (const suffix of ['server/chunks/_/enterprise-read-model.mjs', 'server/chunks/_/current-export-model.mjs']) expect(scopedLoads.some(row => row.pid === workerPids[0] && row.path === join(options.artifact!.root, suffix))).toBe(true)
          for (const stage of ['native-cache-loaded', 'native-shared-object']) expect(scopedLoads.some(row => row.pid === main && row.stage === stage && row.loaded === true && row.path.endsWith('/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node'))).toBe(true)
          expect(scopedLoads.some(row => row.pid === main && row.stage === 'native-shared-object' && row.loaded === true && row.path.endsWith('/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib'))).toBe(true)
          expect(scopedLoads.some(row => row.path.includes('sharp-wasm32') || row.path.includes('/build/Debug/') || row.path.includes('/build/Release/'))).toBe(false)
          atomic('scope-runtime-witness.json', { profileId: options.artifact!.manifest.profileId, main, enterprise: workerPids[0], nativeAndCJSObserved: true, modelsObserved: true, realBusinessControlsRequiredByCase: true, noWriteWorkerStartedForWitness: true })
        }
        atomic('artifact-load-observations.json', loads)
        atomic('app-provenance.json', { mode: 'compiled', profile: 'direct-node', sourceFrontendAxisRequired: false, artifactSHA256: options.artifact!.manifestSHA256, entryTransformCount: options.artifact!.manifest.entryTransform.count, entries: options.artifact!.manifest.entries, sourceMapOwners: options.artifact!.manifest.sourceMapOwners, observedSurfaces: [...new Set(starts.map(row => row.pid + ':' + row.threadId))] })
        return
      }
      const expected = ['server/mcp/index.ts', 'server/mcp/tools/list_enterprises.ts', 'server/mcp/tools/get_enterprise_detail.ts', 'server/routes/mcp-session.ts', 'server/utils/mcp-session-runtime.ts']
      const witnesses: Record<string, string[]> = {}; let filesSeen = 0, mapBytes = 0
      async function walk(path: string) {
        for (const item of await fs.readdir(path, { withFileTypes: true })) {
          if (++filesSeen > 4096 || item.isSymbolicLink()) throw new Error('HARNESS: generated graph bound')
          const name = join(path, item.name)
          if (item.isDirectory()) await walk(name)
          else if (item.name.endsWith('.map')) {
            const raw = await fs.readFile(name); mapBytes += raw.length; if (mapBytes > 64 * 1024 * 1024) throw new Error('HARNESS: source map bytes')
            const map = JSON.parse(raw.toString('utf8')); if (!Array.isArray(map.sources)) continue
            if (map.sources.length > 8192) throw new Error('HARNESS: source map IDs')
            for (const source of map.sources) {
              const id = source.startsWith('file:') ? fileURLToPath(source) : resolve(dirname(name), map.sourceRoot ?? '', source)
              for (const path of expected) if (id === join(project, path)) (witnesses[path] ??= []).push(name)
            }
          }
        }
      }
      await walk(buildDir)
      for (const path of expected) expect(witnesses[path]?.length, 'actual app source map: ' + path).toBeGreaterThan(0)
      const events = await diagnostics()
      const surfaces = new Set(events.filter(row => row.kind === 'start' && row.path === '/mcp-session').map(row => row.pid + ':' + row.threadId))
      expect(surfaces.size, 'actual frontend and worker surfaces, not one simulated listener').toBeGreaterThanOrEqual(2)
      expect(events.some(row => row.kind === 'start' && row.path === '/mcp-session' && row.nativeSocket && row.localPort === port), 'owned frontend port').toBe(true)
      expect(events.some(row => row.kind === 'start' && row.path === '/mcp-session' && row.nativeSocket && row.localPort !== port), 'additional native internal HTTP ingress').toBe(true)
      atomic('app-provenance.json', { witnesses, observedSurfaces: [...surfaces], filesSeen, mapBytes })
    }
    async function stop() {
      if (stopped) return; stopped = true
      let stopReturned = false
      try {
        try { await Promise.all([...sockets].map(socket => new Promise<void>((resolve, reject) => {
          if (socket.closed) return resolve()
          const timer = setTimeout(() => reject(new Error('HARNESS: owned raw socket close')), 1000)
          socket.once('close', () => { clearTimeout(timer); resolve() }); socket.destroy()
        }))) } finally { if (child) await stopOwnedChild(child); stopReturned = true }
        expect(sockets.size).toBe(0)
        const events = await diagnostics()
        atomic('http-diagnostics-summary.json', { events: events.length, surfaces: [...new Set(events.map(row => row.pid + ':' + row.threadId))], overflow: false })
      } finally { try { atomic('shutdown.json', { exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, protocol: 'public stopOwnedChild, owned process group SIGTERM/SIGKILL as needed', sockets: sockets.size }) } finally {
        try { db.$client.close() } finally {
          let observation: ReturnType<typeof setTimeout> | undefined
          try { if (childExit) await Promise.race([childExit, new Promise<void>(resolve => { observation = setTimeout(resolve, 1000) })]) }
          finally { clearTimeout(observation); atomic('normal-close.json', { ownership, dbOpen: db.$client.open, stopReturned, child: childExitReceipt ?? { pid: child?.pid, observedExit: false } }) }
        }
      } }
    }
    async function closedReceipt() {
      if (!stopped || db.$client.open || !childExitReceipt || childExitReceipt.exitCode == null && childExitReceipt.signalCode == null) throw new Error('HARNESS: child/DB closure unproven')
      const { execFileSync } = await import('node:child_process')
      // Public process table, no signals. stopOwnedChild already verified its owned group empty.
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
      const groupEmpty = !rows.some(([pid, group]) => pid === child!.pid || group === child!.pid)
      if (!groupEmpty) throw new Error('HARNESS: previous owned PID/group remains')
      const result = { dbOpen: db.$client.open, child: childExitReceipt, ownedGroupEmpty: groupEmpty, sockets: sockets.size }
      atomic('restart-close.json', result); return result
    }
    let stickySeq = 0
    async function setStickyCredential(value: string) {
      if (!options.stickyControlNonce || !child?.connected || stickySeq >= 2 || !/^[0-9a-f]{48}$/.test(value)) throw new Error('HARNESS: sticky IPC unavailable')
      if (!credentialRedactions.includes(value)) { if (credentialRedactions.length >= 2) throw new Error('HARNESS: sticky credential bound'); credentialRedactions.push(value) }
      const seq = ++stickySeq, owned = child
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); owned.off('message', reply); owned.off('exit', closed); owned.off('disconnect', closed) }
        const closed = () => { cleanup(); reject(new Error('HARNESS: sticky IPC closed')) }
        const reply = (message: unknown) => {
          if (!message || typeof message !== 'object' || !('channel' in message) || message.channel !== '445-owned-sticky-v1') return
          const row = message as { nonce?: unknown; seq?: unknown; applied?: unknown }
          if (row.nonce !== options.stickyControlNonce || !('kind' in message) || message.kind !== 'ack' || row.seq !== seq) return
          cleanup(); if (row.applied === true) resolve(); else reject(new Error('HARNESS: sticky IPC not applied'))
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error('HARNESS: sticky IPC timeout')) }, 3000)
        owned.on('message', reply); owned.once('exit', closed); owned.once('disconnect', closed)
        owned.send({ channel: '445-owned-sticky-v1', nonce: options.stickyControlNonce, op: 'set-token', seq, value }, error => { if (error) { cleanup(); reject(new Error('HARNESS: sticky IPC send failed')) } })
      })
      record({ kind: 'sticky-ipc', seq, applied: true })
    }
    async function stickyCurrentConfigWitness(seq: number) {
      if (!options.stickyControlNonce || stickyConfigNotify) throw new Error('HARNESS: sticky witness unavailable')
      if (!stickyConfigRows.length) await new Promise<void>((resolve, reject) => {
        const done = () => { if (stickyConfigRows.length || logFault || !child?.connected) { clearTimeout(timer); stickyConfigNotify = undefined; resolve() } }
        const timer = setTimeout(() => { stickyConfigNotify = undefined; reject(new Error('HARNESS: actual event config witness timeout')) }, 3000)
        stickyConfigNotify = done; done()
      })
      live(); const row = stickyConfigRows.shift()
      expect(row).toEqual({ seq, cached: true, currentEqualsApplied: true })
      record({ kind: 'sticky-current-credential-guard', ...row })
    }
    return { directory, base, token, rpc, sdk, record, snapshot, diagnostics, provenance, sockets, live, boundedBody, stop, businessState, closedReceipt, setStickyCredential, stickyCurrentConfigWitness }
  } catch (error) {
    let stopReturned = false
    try {
      if (child) await stopOwnedChild(child)
      stopReturned = true
    } finally {
      try { db.$client.close() }
      finally {
        let observation: ReturnType<typeof setTimeout> | undefined
        try { if (childExit) await Promise.race([childExit, new Promise<void>(resolve => { observation = setTimeout(resolve, 1000) })]) }
        finally {
          clearTimeout(observation)
          atomic('startup-failure-close.json', { ownership, dbOpen: db.$client.open, stopAttempted: !!child, stopReturned, child: childExitReceipt ?? { pid: child?.pid, observedExit: false }, protocol: 'public stopOwnedChild; explicit ChildProcess event receipt, not test-root exit' })
        }
      }
    }
    throw error
  }
}

type App445 = Awaited<ReturnType<typeof start445ActualApp>>
function app445Payload(result: any) {
  expect(result.isError).not.toBe(true)
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return JSON.parse(result.content[0].text)
}
async function app445ReadControl(app: App445, authorized = false) {
  const session = await app.sdk('/mcp-session', authorized)
  try {
    expect((await session.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_enterprise_detail', 'list_enterprises'])
    const list = app445Payload(await session.client.callTool({ name: 'list_enterprises', arguments: { q: APP445_ENTERPRISE.name } }))
    expect(list).toMatchObject({ counts: { total: 1 }, page: 1, pageSize: 50, rows: [APP445_ENTERPRISE] })
    const detail = app445Payload(await session.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } }))
    expect(detail.enterprise).toMatchObject(APP445_ENTERPRISE)
    return session
  } catch (error) { await session.close(); throw error }
}

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-native-preflight')('445 actual app native', () => {
  it('P_native_preflight_uses_assigned_shipped_binary', async () => {
    const identity = await native445Identity()
    expect(identity).toMatchObject({ node: 'v24.22.1', platform: 'darwin', arch: 'arm64' })
    const { writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os')
    await writeFile(join(tmpdir(), '445-native-identity.json'), JSON.stringify(identity, null, 2), { flag: 'wx', mode: 0o600 })
  })
})

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-source-control')('445 actual app source', () => {
  it('A_source_real_tools_legacy_and_HTTP_literals', async () => {
    const app = await start445ActualApp()
    try {
      const session = await app445ReadControl(app)
      try { await app.provenance() } finally { await session.close() }
      const legacy = await app.sdk('/mcp')
      try {
        const names = (await legacy.client.listTools()).tools.map(tool => tool.name)
        expect(names).toContain('list_enterprises'); expect(names).toContain('get_enterprise_detail'); expect(names).not.toContain('save_ocr_result')
        expect(app445Payload(await legacy.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        expect(legacy.transport.sessionId).toBeUndefined()
      } finally { await legacy.close() }
      const direct = await app.rpc('/mcp', { jsonrpc: '2.0', id: 4451, method: 'tools/call', params: { name: 'list_enterprises', arguments: { q: '445隔离企业' } } })
      expect(direct.response.status).toBe(200); expect(direct.response.headers.has('mcp-session-id')).toBe(false)
      expect(app445Payload(direct.body.result)).toMatchObject({ counts: { total: 1 }, rows: [APP445_ENTERPRISE] })
      const rest = await fetch(app.base + '/api/roster/enterprises/445001', { signal: AbortSignal.timeout(15000) })
      expect(rest.status).toBe(200); expect(JSON.parse(await app.boundedBody(rest)).enterprise).toMatchObject(APP445_ENTERPRISE)
    } finally { await app.stop() }
  }, 180000)
})

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-source-denials')('445 actual app protection', () => {
  it('B_valid_schema_auth_task_and_alternate_header_zero_effects', async () => {
    const app = await start445ActualApp()
    try {
      const session = await app445ReadControl(app)
      try {
        const authorized = await app.sdk('/mcp', true)
        try {
          const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv')
          const tools = (await authorized.client.listTools()).tools
          for (const [name, args] of [['save_ocr_result', APP445_WRITE], ['get_roster_evidence', APP445_OFFICIAL]] as const) {
            const tool = tools.find(tool => tool.name === name); expect(tool, 'real registered tool schema').toBeDefined()
            expect(new AjvJsonSchemaValidator().getValidator(tool!.inputSchema)(args).valid).toBe(true)
          }
        } finally { await authorized.close() }
        const before = await app.snapshot()
        app.record({ kind: 'side-effects-before', snapshot: before })
        for (const [headers, reason] of [[{}, 'token-missing'], [{ authorization: 'Bearer 445-deliberately-invalid' }, 'token-invalid']] as const) {
          const denied = await app.rpc('/mcp', { jsonrpc: '2.0', id: 4452, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, headers)
          expect(denied.response.status).toBe(401); expect(denied.body.error).toMatchObject({ code: -32001, data: { tool: 'save_ocr_result', reason } })
        }
        const sensitive = await app.rpc('/mcp', { jsonrpc: '2.0', id: 4453, method: 'tools/call', params: { name: 'get_roster_evidence', arguments: APP445_OFFICIAL } })
        expect(sensitive.response.status).toBe(401); expect(sensitive.body.error).toMatchObject({ code: -32001, message: 'Configured MCP token required' })
        for (const headers of [{ authorization: 'Bearer 445-deliberately-invalid' }, { 'x-mcp-token': '' }, { 'x-mcp-token': app.token }, { 'x-mcp-token': '445-other' }, { authorization: 'Bearer ' + app.token, 'x-mcp-token': '' }, { authorization: 'Bearer ' + app.token, 'x-mcp-token': app.token }] as Record<string, string>[]) {
          const denied = await app.rpc('/mcp-session', APP445_INIT, headers)
          expect(denied.response.status).toBe(401); expect(denied.body.error.message).toBe('invalid_identity')
        }
        const sid = session.transport.sessionId; expect(typeof sid).toBe('string')
        const headers = { authorization: 'Bearer ' + app.token, 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-03-26' }
        // This session was anonymous: valid-token cannot adopt it. Use its original identity.
        const originalHeaders = { 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-03-26' }
        const forbidden = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 4454, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, originalHeaders)
        expect(forbidden.response.status).toBe(403); expect(forbidden.body.error.code).toBe('tool_not_allowed')
        const writer = await app.sdk('/mcp-session', true)
        try {
          expect((await writer.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_enterprise_detail', 'list_enterprises'])
          const denied = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 4458, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, { authorization: 'Bearer ' + app.token, 'mcp-session-id': writer.transport.sessionId!, 'mcp-protocol-version': '2025-03-26' })
          expect(denied.response.status).toBe(403); expect(denied.body.error.code).toBe('tool_not_allowed')
        } finally { await writer.close() }
        for (const frame of [
          { method: 'tools/call', params: { name: 'list_enterprises', arguments: {}, task: { ttl: 1000 } } },
          { method: 'tools/call', params: { name: 'list_enterprises', arguments: {}, _meta: { 'io.modelcontextprotocol/related-task': { taskId: '445-owned' } } } },
          { method: 'tasks/get', params: { taskId: '445-owned' } },
        ]) {
          const denied = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 4455, ...frame }, originalHeaders)
          expect(denied.response.status).toBe(400); expect(denied.body.error.code).toBe('task_not_supported')
        }
        const ordinary = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 4456, method: 'tools/call', params: { name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 }, _meta: { ordinary: '445-kept' } } }, originalHeaders)
        expect(ordinary.response.status).toBe(200); expect(app445Payload(ordinary.body.result).enterprise).toMatchObject(APP445_ENTERPRISE)
        // A same-sid principal switch must fail, not borrow the anonymous owner.
        const foreign = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 4457, method: 'tools/list' }, headers)
        expect(foreign.response.status).toBe(404)
        expect(foreign.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'session_not_found', data: { code: 'session_not_found' } } })
        expect(session.transport.sessionId === sid).toBe(true)
        expect((await session.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_enterprise_detail', 'list_enterprises'])
        expect(app445Payload(await session.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        app.record({ kind: 'owner-isolation', sessionNotFound: true, originalSidUnchanged: true, anonymousOwnerRead: true })
        const after = await app.snapshot()
        app.record({ kind: 'side-effects-after', snapshot: after })
        expect(after).toEqual(before)
        app.record({ kind: 'zero-side-effects', database: true, businessFiles: true, actualSchemaGuards: 2 })
      } finally { await session.close() }
    } finally { await app.stop() }
  }, 180000)
})

// Small HTTP/1 framing reader for owned raw probes only; no SDK dispatcher copy.
function parse445HTTP(bytes: Buffer, eof = false): { status: number; headers: Record<string, string>; body: string }[] {
  const frames: { status: number; headers: Record<string, string>; body: string }[] = []; let offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf('\r\n\r\n', offset); if (end < 0) break
    const lines = bytes.subarray(offset, end).toString('latin1').split('\r\n'); const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines.shift()!)?.[1])
    if (!Number.isInteger(status)) throw new Error('HARNESS: raw HTTP status')
    const headers = Object.fromEntries(lines.map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()] }))
    let cursor = end + 4; const chunks: Buffer[] = []
    if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
      let complete = false
      while (cursor < bytes.length) {
        const line = bytes.indexOf('\r\n', cursor); if (line < 0) break
        const length = Number.parseInt(bytes.subarray(cursor, line).toString('ascii').split(';')[0]!, 16)
        if (!Number.isSafeInteger(length) || length < 0) throw new Error('HARNESS: raw chunk length')
        cursor = line + 2
        if (length === 0) { if (bytes.subarray(cursor, cursor + 2).toString() !== '\r\n') break; cursor += 2; complete = true; break }
        if (cursor + length + 2 > bytes.length) break
        chunks.push(bytes.subarray(cursor, cursor + length)); cursor += length + 2
      }
      if (!complete) break
    } else {
      const length = headers['content-length'] === undefined ? ([204, 304].includes(status) ? 0 : eof ? bytes.length - cursor : NaN) : Number(headers['content-length'])
      if (!Number.isSafeInteger(length) || length < 0 || cursor + length > bytes.length) break
      chunks.push(bytes.subarray(cursor, cursor + length)); cursor += length
    }
    frames.push({ status, headers, body: Buffer.concat(chunks).toString('utf8') }); offset = cursor
  }
  return frames
}
async function raw445(app: App445, wire: string | Buffer, count: number, disconnect = false) {
  const { createConnection } = await import('node:net'); const url = new URL(app.base)
  return await new Promise<ReturnType<typeof parse445HTTP>>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) }); app.sockets.add(socket)
    let bytes = Buffer.alloc(0), settled = false; let disconnectTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(disconnectTimer); socket.destroy(); if (error) reject(error); else try { resolve(parse445HTTP(bytes, true)) } catch (error) { reject(error) } }
    const timer = setTimeout(() => finish(new Error('HARNESS: raw socket deadline')), 10000)
    socket.once('connect', () => { socket.write(wire); if (disconnect) disconnectTimer = setTimeout(() => finish(), 250) })
    socket.on('data', (part: Buffer) => { bytes = Buffer.concat([bytes, part]); if (bytes.length > 262144) return finish(new Error('HARNESS: raw body limit')); try { if (parse445HTTP(bytes).length >= count) finish() } catch (error) { finish(error as Error) } })
    socket.once('error', error => finish(error)); socket.once('close', () => { app.sockets.delete(socket); if (!settled) try { if (parse445HTTP(bytes, true).length < count && !disconnect) finish(new Error('HARNESS: short raw response')); else finish() } catch (error) { finish(error as Error) } })
  })
}

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-source-socket')('445 actual app raw socket', () => {
  it('D_normal_shared_pipeline_and_init_disconnect_preserve_other_caller', async () => {
    const app = await start445ActualApp()
    try {
      const sibling = await app445ReadControl(app)
      try {
        const get = 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n'
        const normal = await raw445(app, get + 'Connection: close\r\n\r\n', 1)
        expect(normal.map(row => row.status)).toEqual([200]); expect(JSON.parse(normal[0]!.body)).toMatchObject({ recordCount: 0 })
        const pipe = await raw445(app, get + '\r\n' + get + 'Connection: close\r\n\r\n', 2)
        expect(pipe.map(row => row.status)).toEqual([200, 200])
        const body = JSON.stringify(APP445_INIT)
        const init = 'POST /mcp-session HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n'
        const shared = await raw445(app, init + body + get + 'Connection: close\r\n\r\n', 2)
        expect(shared.map(row => row.status)).toEqual([200, 200])
        const sid = shared[0]!.headers['mcp-session-id']; expect(typeof sid).toBe('string')
        const removed = await fetch(app.base + '/mcp-session', { method: 'DELETE', headers: { 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-03-26' }, signal: AbortSignal.timeout(10000) })
        expect(removed.status).toBe(204)
        await raw445(app, init + body.slice(0, 2), 1, true)
        expect(app445Payload(await sibling.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        await app.provenance()
        const events = await app.diagnostics()
        expect(events.some(row => row.kind === 'start' && row.path === '/mcp-session')).toBe(true)
        expect(new Set(events.filter(row => row.kind === 'aborted' && row.path === '/mcp-session').map(row => row.pid + ':' + row.threadId)).size, 'disconnect reached frontend AND worker').toBeGreaterThanOrEqual(2)
        app.record({ kind: 'raw-pipeline-disconnect', normal: 1, pipeline: 2, sessionThenOther: 2, siblingRead: true })
      } finally { await sibling.close() }
    } finally { await app.stop() }
  }, 180000)
  it('E_framing_public_errors_are_attributed_without_fake_worker_pass', async () => {
    const app = await start445ActualApp()
    try {
      const control = await app445ReadControl(app)
      try {
        await app.provenance()
        const { gzipSync } = await import('node:zlib')
        const body = JSON.stringify(APP445_INIT), prefix = 'POST /mcp-session HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n'
        const compressed = gzipSync(Buffer.from(body))
        const large = JSON.stringify({ ...APP445_INIT, params: { ...APP445_INIT.params, _meta: { padding: 'x'.repeat(16385) } } })
        for (const [label, headers, payload, status] of [
          ['duplicate-cl', 'Content-Length: 1\r\nContent-Length: 1\r\n', 'x', 400],
          ['te-cl', 'Transfer-Encoding: chunked\r\nContent-Length: 1\r\n', '0\r\n\r\n', 400],
          ['missing-cl', '', '', 400],
          ['compressed', 'Content-Encoding: gzip\r\nContent-Length: ' + compressed.length + '\r\n', compressed, 400],
          ['large-init', 'Content-Length: ' + Buffer.byteLength(large) + '\r\n', large, 413],
        ] as const) {
          const eventKey = (row: any) => [row.pid, row.threadId, row.kind, row.id].join(':')
          const eventsBefore = new Set((await app.diagnostics()).map(eventKey))
          const frames = await raw445(app, Buffer.concat([Buffer.from(prefix + headers + '\r\n'), typeof payload === 'string' ? Buffer.from(payload) : payload]), 1)
          expect(frames).toHaveLength(1); expect(frames[0]!.status, label).toBe(status)
          const events = (await app.diagnostics()).filter(row => !eventsBefore.has(eventKey(row)))
          const routeSpecific = /invalid_framing|body_too_large/.test(frames[0]!.body)
          const starts = events.filter(row => row.kind === 'start' && row.path === '/mcp-session' && row.method === 'POST')
          if (label === 'duplicate-cl' || label === 'te-cl') expect(starts).toHaveLength(0) // Node parser, before app dispatch.
          else expect(frames[0]!.body).toContain(label === 'large-init' ? 'body_too_large' : 'invalid_framing')
          app.record({ kind: 'framing', label, status, routeSpecific, reached: events.filter(row => row.kind === 'start').map(row => ({ pid: row.pid, threadId: row.threadId, cl: row.cl, te: row.te, encoded: row.encoded })), attribution: routeSpecific ? 'adapter-specific refusal' : 'parser-or-proxy; exact layer unresolved unless diagnostics prove it' })
          expect(app445Payload(await control.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        }
      } finally { await control.close() }
    } finally { await app.stop() }
  }, 180000)
})

// Independent public-body consumption pair. No Nuxt/app/DB/listener is started.
describe.skipIf(process.env.ISSUE445_PHASE !== 'body-replay-pair')('445 public H3 SDK body replay', () => {
  it('P_consumed_web_request_400_and_cached_fresh_request_initialize_200', async () => {
    const fs = await import('node:fs/promises')
    const { createHash, randomUUID } = await import('node:crypto')
    const { tmpdir } = await import('node:os')
    const { pathToFileURL } = await import('node:url')
    const { createApp, eventHandler, toWebHandler, readBody } = await import('h3')
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
    const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    const project = await fs.realpath(join(import.meta.dirname, '..'))
    const installation = await fs.realpath(join(project, 'node_modules'))
    const grantDirectory = dirname(tmpdir())
    const grant = JSON.parse(await fs.readFile(join(grantDirectory, 'grant.raw'), 'utf8'))
    expect(await fs.realpath(grant.root)).toBe(await fs.realpath(grantDirectory))
    expect(grant.phase).toBe('body-replay-pair')
    const rows: Record<string, unknown>[] = []
    const persist = async (row: Record<string, unknown>) => {
      if (rows.length >= 16) throw new Error('HARNESS: paired receipt bound')
      rows.push(row)
      const target = join(grantDirectory, 'paired-observations.json')
      await fs.writeFile(target + '.tmp', JSON.stringify(rows, null, 2), { mode: 0o600 })
      await fs.rename(target + '.tmp', target)
    }
    const toolkit = dirname(fileURLToPath(import.meta.resolve('@nuxtjs/mcp-toolkit')))
    const compatPath = await fs.realpath(join(toolkit, 'runtime/server/mcp/compat.js'))
    const digest = async (path: string) => createHash('sha256').update(await fs.readFile(path)).digest('hex')
    expect(compatPath.startsWith(installation + '/')).toBe(true)
    expect(await digest(compatPath)).toBe('639493f529e7b8e78483ea8ac820357354d00d2240eb6860cc2ea9df40fd7089')
    const packageControls = []
    for (const [name, version, entry] of [
      ['@nuxtjs/mcp-toolkit', '0.24.2', join(toolkit, 'module.mjs')],
      ['h3', '1.15.11', fileURLToPath(import.meta.resolve('h3'))],
      ['@modelcontextprotocol/sdk', '1.32.1', fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))],
    ]) {
      const realEntry = await fs.realpath(entry!)
      expect(realEntry.startsWith(installation + '/')).toBe(true)
      let directory = dirname(realEntry), found = false
      while (directory.startsWith(installation + '/')) {
        const pkg = await fs.readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse, () => null)
        if (pkg?.name === name) {
          expect(pkg.version).toBe(version); found = true
          packageControls.push({ name, version, realEntry, entrySHA256: await digest(realEntry), packageSHA256: await digest(join(directory, 'package.json')) })
          break
        }
        directory = dirname(directory)
      }
      expect(found, 'INFRA: actual package owner required before paired expectations').toBe(true)
    }
    const { toWebRequest } = await import(/* @vite-ignore */ pathToFileURL(compatPath).href)
    expect(typeof toWebRequest).toBe('function')
    await persist({ stage: 'imports', packageControls, compatPath, compatSHA256: await digest(compatPath), actualPublicCompat: true })
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
          await persist({ stage: 'middleware', side, middlewareParsed, bodyUsed: original!.bodyUsed, initEntered, sidPresent: typeof transport.sessionId === 'string' })
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
          await persist({ stage: 'before-sdk', side, sameWebRequest: request === event.web!.request, bodyUsed: request.bodyUsed, cachedLiteralSame: await readBody(event, { strict: false }) === parsed })
          return transport.handleRequest(request)
        }))
        const response = await toWebHandler(app)(new Request(url, { method: 'POST', headers, body: bytes }))
        const payload = await response.json()
        const errorCode = typeof payload?.error?.code === 'number' && [-32700, -32600, -32000].includes(payload.error.code) ? payload.error.code : null
        const sidPresent = typeof transport.sessionId === 'string'
        const sidEqual = sidPresent && response.headers.get('mcp-session-id') === transport.sessionId
        await persist({ stage: 'sdk-response', side, status: response.status, errorCode, middlewareParsed, initEntered, initSettled, sidPresent, sidEqual })
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
          try { await transport.close(); closeTransport = true }
          finally { await persist({ stage: 'close', side, closeServer, closeTransport, externalStorageUsed: false, listenerUsed: false }) }
        }
      }
      expect(closeServer).toBe(true); expect(closeTransport).toBe(true)
    }
    await persist({ stage: 'paired-complete', expectedA400: true, expectedB200: true, noApp: true, noDB: true })
  }, 15000)
})

// Narrow response-disposal literals. Separate grant required; old B/D/E stay exact.
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
describe.skipIf(process.env.ISSUE445_PHASE !== 'early-refusal-literals')('445 early refusal literals', () => {
  it('L_exact_JSON_native_end_precedes_termination_for_each_early_exit', async () => {
    const { createResponseTermination, queueSessionResponse } = await import('../server/utils/mcp-session-runtime')
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
    const { createResponseTermination } = await import('../server/utils/mcp-session-runtime')
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
    const { createResponseTermination } = await import('../server/utils/mcp-session-runtime')
    const { createSocketOwnership } = await import('../server/utils/mcp-session-transport')
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
    const { createResponseTermination, queueSessionResponse } = await import('../server/utils/mcp-session-runtime')
    const { createSocketOwnership, createSessionInitializationTransport } = await import('../server/utils/mcp-session-transport')
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

// Additional future wire guard; does not replace unchanged B or D/E.
describe.skipIf(process.env.ISSUE445_PHASE !== 'app-source-early-refusal')('445 actual app early refusal', () => {
  it('W_wrong_auth_exact_401_and_prior_later_frontend_pipeline_survive', async () => {
    const app = await start445ActualApp()
    try {
      const sibling = await app445ReadControl(app) // Actual installation/read-tool control first.
      try {
        const denied = await app.rpc('/mcp-session', APP445_INIT, { authorization: 'Bearer 445-deliberately-invalid' })
        expect(denied.response.status).toBe(401)
        expect(denied.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'invalid_identity' } })
        const body = JSON.stringify(APP445_INIT)
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16384)
        const get = 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
        const post = 'POST /mcp-session HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer 445-deliberately-invalid\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n'
        // One public socket, prior and later requests; NO Connection:close fix.
        // Existing raw445 destroys its test socket only after all3 replies arrive.
        const replies = await raw445(app, get + post + body + get, 3)
        expect(replies.map(reply => reply.status)).toEqual([200, 401, 200])
        expect(JSON.parse(replies[0]!.body)).toMatchObject({ recordCount: 0 })
        expect(JSON.parse(replies[1]!.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'invalid_identity' } })
        expect(JSON.parse(replies[2]!.body)).toMatchObject({ recordCount: 0 })
        expect(app445Payload(await sibling.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        await app.provenance()
        const events = await app.diagnostics()
        for (const threadId of [0, 1]) {
          expect(events.some(row => row.kind === 'finish' && row.path === '/mcp-session' && row.threadId === threadId && row.status === 401)).toBe(true)
        }
        app.record({ kind: 'early-refusal-wire', singleStatus: 401, pipelineStatuses: [200, 401, 200], siblingLiteral: true })
      } finally { await sibling.close() }
    } finally { await app.stop() }
  }, 180000)
})

// Public-native fixture doubles only. No vendor dispatcher, fake business tool or server.
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

describe.skipIf(process.env.ISSUE445_PHASE !== 'frontend-literals')('445 public frontend literals', () => {
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

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-source-public-framing')('445 actual app public frontend', () => {
  it('F_missing_length_exact_400_pipeline_sibling_and_legacy_survive', async () => {
    const app = await start445ActualApp()
    try {
      const sibling = await app445ReadControl(app)
      try {
        const get = 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
        const missing = 'POST /mcp-session?owned=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\r\n'
        const workerPostsBefore = (await app.diagnostics()).filter(row => row.threadId === 1 && row.kind === 'start' && row.path === '/mcp-session' && row.method === 'POST').length
        const replies = await raw445(app, get + missing + get, 3)
        expect((await app.diagnostics()).filter(row => row.threadId === 1 && row.kind === 'start' && row.path === '/mcp-session' && row.method === 'POST')).toHaveLength(workerPostsBefore)
        expect(replies.map(row => row.status)).toEqual([200, 400, 200])
        expect(JSON.parse(replies[1]!.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'invalid_framing', data: { code: 'invalid_framing' } } })
        expect(replies[1]!.headers['content-length']).toBe(String(Buffer.byteLength(replies[1]!.body)))
        expect(app445Payload(await sibling.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        // Existing stateless provider remains reachable; the literal separately proves missing-CL old-route bypass.
        const legacy = await app.sdk('/mcp')
        try { expect((await legacy.client.listTools()).tools.some(tool => tool.name === 'list_enterprises')).toBe(true) } finally { await legacy.close() }
        const old = await app.rpc('/mcp', { jsonrpc: '2.0', id: 445, method: 'tools/list', params: {} })
        expect(old.response.status).toBe(200)
        const events = await app.diagnostics()
        expect(events.some(row => row.threadId === 0 && row.path === '/mcp-session' && row.method === 'POST' && row.cl === 0)).toBe(true)
        const fs = await import('node:fs/promises')
        const frontFiles = await fs.readdir(join(app.directory, 'frontend'))
        const rows = (await Promise.all(frontFiles.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await fs.readFile(join(app.directory, 'frontend', file), 'utf8'))))).flat()
        expect(rows.some(row => row.stage === 'installed' && row.threadId === 0)).toBe(true)
        expect(rows.some(row => row.stage === 'app-entered' && row.threadId === 0 && row.owned)).toBe(true)
        expect(rows.some(row => row.stage === 'refusal-end' && row.threadId === 0 && row.status === 400 && row.owned && row.ended)).toBe(true)
        expect(rows.some(row => row.stage === 'overflow')).toBe(false)
        app.record({ kind: 'public-framing-pipeline', frames: replies.map(row => ({ status: row.status, bytes: Buffer.byteLength(row.body), contentLength: row.headers['content-length'] ?? null, chunked: row.headers['transfer-encoding'] === 'chunked', sessionHeader: row.headers['mcp-session-id'] !== undefined })), statuses: replies.map(row => row.status), safeCode: 'invalid_framing', siblingLiteral: true, legacyRead: true })
        await app.provenance()
      } finally { await sibling.close() }
    } finally { await app.stop() }
  }, 180000)
})

// No build in these tests. A separately granted ordinary Nuxt build must supply
// a closed artifact + release-first validation receipt before any compiled run.
describe.skipIf(process.env.ISSUE445_PHASE !== 'app-compiled-control')('445 actual app compiled', () => {
  it('C_direct_node_real_tools_legacy_HTTP_REST_and_artifact', async () => {
    const artifact = await compiled445Artifact(), app = await start445ActualApp({ mode: 'compiled', artifact })
    try {
      const session = await app445ReadControl(app)
      try { await app.provenance() } finally { await session.close() }
      const legacy = await app.sdk('/mcp')
      try {
        const names = (await legacy.client.listTools()).tools.map(tool => tool.name)
        expect(names).toContain('list_enterprises'); expect(names).toContain('get_enterprise_detail'); expect(names).not.toContain('save_ocr_result')
        expect(legacy.transport.sessionId === undefined).toBe(true)
        expect(app445Payload(await legacy.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
      } finally { await legacy.close() }
      const direct = await app.rpc('/mcp', { jsonrpc: '2.0', id: 44561, method: 'tools/call', params: { name: 'list_enterprises', arguments: { q: APP445_ENTERPRISE.name } } })
      expect(direct.response.status).toBe(200); expect(direct.response.headers.has('mcp-session-id')).toBe(false)
      expect(app445Payload(direct.body.result)).toMatchObject({ counts: { total: 1 }, rows: [APP445_ENTERPRISE] })
      const rest = await fetch(app.base + '/api/roster/enterprises/445001', { signal: AbortSignal.timeout(15000) })
      expect(rest.status).toBe(200); expect(JSON.parse(await app.boundedBody(rest)).enterprise).toMatchObject(APP445_ENTERPRISE)
      app.record({ kind: 'compiled-normal', profile: 'direct-node', twoRealReadTools: true, legacySDK: true, noHeaderHTTP: true, REST: true, artifactSHA256: artifact.manifestSHA256, sourceFrontendRequired: false })
    } finally { await app.stop(); await app.closedReceipt(); await artifact.verify() }
  }, 180000)
})

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-compiled-denials')('445 actual app compiled protection', () => {
  it('N_valid_schema_exact_auth_task_readonly_and_zero_effects', async () => {
    const artifact = await compiled445Artifact(), app = await start445ActualApp({ mode: 'compiled', artifact })
    try {
      const session = await app445ReadControl(app)
      try {
        const authorized = await app.sdk('/mcp', true)
        try {
          const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv')
          const tools = (await authorized.client.listTools()).tools
          for (const [name, args] of [['save_ocr_result', APP445_WRITE], ['get_roster_evidence', APP445_OFFICIAL]] as const) {
            const tool = tools.find(tool => tool.name === name); expect(tool).toBeDefined()
            expect(new AjvJsonSchemaValidator().getValidator(tool!.inputSchema)(args).valid).toBe(true)
          }
        } finally { await authorized.close() }
        const before = await app.snapshot(); app.record({ kind: 'compiled-before', snapshot: before })
        for (const [headers, reason] of [[{}, 'token-missing'], [{ authorization: 'Bearer 445-deliberately-invalid' }, 'token-invalid']] as const) {
          const denied = await app.rpc('/mcp', { jsonrpc: '2.0', id: 44562, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, headers)
          expect(denied.response.status).toBe(401); expect(denied.body.error).toMatchObject({ code: -32001, data: { tool: 'save_ocr_result', reason } })
        }
        const sensitive = await app.rpc('/mcp', { jsonrpc: '2.0', id: 44563, method: 'tools/call', params: { name: 'get_roster_evidence', arguments: APP445_OFFICIAL } })
        expect(sensitive.response.status).toBe(401); expect(sensitive.body.error).toMatchObject({ code: -32001, message: 'Configured MCP token required' })
        for (const headers of [{ authorization: 'Bearer 445-deliberately-invalid' }, { 'x-mcp-token': '' }, { 'x-mcp-token': app.token }, { authorization: 'Bearer ' + app.token, 'x-mcp-token': '' }] as Record<string, string>[]) {
          const denied = await app.rpc('/mcp-session', APP445_INIT, headers)
          expect(denied.response.status).toBe(401); expect(denied.body.error.message).toBe('invalid_identity')
        }
        const sid = session.transport.sessionId; expect(typeof sid).toBe('string')
        const original = { 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-03-26' }
        const forbidden = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44564, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, original)
        expect(forbidden.response.status).toBe(403); expect(forbidden.body.error.code).toBe('tool_not_allowed')
        const writer = await app.sdk('/mcp-session', true)
        try {
          expect((await writer.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_enterprise_detail', 'list_enterprises'])
          const denied = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44567, method: 'tools/call', params: { name: 'save_ocr_result', arguments: APP445_WRITE } }, { authorization: 'Bearer ' + app.token, 'mcp-session-id': writer.transport.sessionId!, 'mcp-protocol-version': '2025-03-26' })
          expect(denied.response.status).toBe(403); expect(denied.body.error.code).toBe('tool_not_allowed')
        } finally { await writer.close() }
        for (const frame of [{ method: 'tasks/get', params: { taskId: '445-owned' } }, { method: 'tools/call', params: { name: 'list_enterprises', arguments: {}, task: { ttl: 1000 } } }, { method: 'tools/call', params: { name: 'list_enterprises', arguments: {}, _meta: { 'io.modelcontextprotocol/related-task': { taskId: '445-owned' } } } }]) {
          const denied = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44565, ...frame }, original)
          expect(denied.response.status).toBe(400); expect(denied.body.error.code).toBe('task_not_supported')
        }
        const foreign = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44566, method: 'tools/list' }, { ...original, authorization: 'Bearer ' + app.token })
        expect(foreign.response.status).toBe(404); expect(foreign.body.error).toEqual({ code: -32000, message: 'session_not_found', data: { code: 'session_not_found' } })
        expect(app445Payload(await session.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        const after = await app.snapshot(); expect(after).toEqual(before); app.record({ kind: 'compiled-zero-effects', snapshot: after, validSchemaGuards: 2, exactDenials: true })
        await app.provenance()
      } finally { await session.close() }
    } finally { await app.stop(); await app.closedReceipt(); await artifact.verify() }
  }, 180000)
})

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-compiled-framing')('445 actual app compiled raw', () => {
  it('R_direct_listener_framing_pipeline_and_sibling', async () => {
    const artifact = await compiled445Artifact(), app = await start445ActualApp({ mode: 'compiled', artifact })
    try {
      const session = await app445ReadControl(app)
      try {
        const get = 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
        const missing = 'POST /mcp-session?owned=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
        const replies = await raw445(app, get + missing + get, 3)
        expect(replies.map(row => row.status)).toEqual([200, 400, 200])
        expect(JSON.parse(replies[1]!.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'invalid_framing', data: { code: 'invalid_framing' } } })
        expect(replies[1]!.headers['content-length']).toBe(String(Buffer.byteLength(replies[1]!.body)))
        const { gzipSync } = await import('node:zlib'); const compressed = gzipSync(Buffer.from(JSON.stringify(APP445_INIT)))
        const large = Buffer.from(JSON.stringify({ ...APP445_INIT, params: { ...APP445_INIT.params, _meta: { padding: 'x'.repeat(16385) } } }))
        const prefix = 'POST /mcp-session HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n'
        for (const [headers, body, status, code] of [['Content-Encoding: gzip\r\nContent-Length: ' + compressed.length + '\r\n', compressed, 400, 'invalid_framing'], ['Content-Length: ' + large.length + '\r\n', large, 413, 'body_too_large']] as const) {
          const frame = await raw445(app, Buffer.concat([Buffer.from(prefix + headers + '\r\n'), body]), 1)
          expect(frame[0]!.status).toBe(status); expect(JSON.parse(frame[0]!.body).error.data.code).toBe(code)
        }
        const parser = await raw445(app, prefix + 'Content-Length: 1\r\nContent-Length: 1\r\n\r\nx', 1)
        expect(parser[0]!.status).toBe(400); expect(parser[0]!.body.includes('invalid_framing')).toBe(false)
        expect(app445Payload(await session.client.callTool({ name: 'get_enterprise_detail', arguments: { enterpriseId: 445001 } })).enterprise).toMatchObject(APP445_ENTERPRISE)
        await app.provenance()
        const diagnostics = await app.diagnostics(); expect(diagnostics.some(row => row.kind === 'finish' && row.path === '/mcp-session' && row.status === 413 && row.threadId === 0)).toBe(true)
        app.record({ kind: 'compiled-framing', pipeline: [200, 400, 200], missingCode: 'invalid_framing', gzipCode: 'invalid_framing', overStatus: 413, overCode: 'body_too_large', parser400: true, onePublicNativeIngress: true, siblingLiteral: true })
      } finally { await session.close() }
    } finally { await app.stop(); await app.closedReceipt(); await artifact.verify() }
  }, 180000)
})

describe.skipIf(process.env.ISSUE445_PHASE !== 'app-compiled-epoch')('445 actual app compiled epoch', () => {
  it('E_three_process_A_B_A_old_authorized_and_anonymous_sid_never_revive', async () => {
    const artifact = await compiled445Artifact(), fs = await import('node:fs/promises'), { randomBytes } = await import('node:crypto'), { tmpdir } = await import('node:os')
    const tokenA = randomBytes(24).toString('hex'), tokenB = randomBytes(24).toString('hex'); expect(tokenA === tokenB).toBe(false)
    let business: Business445 | undefined, originalState: Awaited<ReturnType<App445['snapshot']>> | undefined
    const prior: { authorized: string; anonymous: string }[] = [], phases: Record<string, unknown>[] = []
    for (const [label, token, obsoleteToken] of [['A1', tokenA, tokenB], ['B2', tokenB, tokenA], ['A3', tokenA, tokenB]] as const) {
      // Previous iteration's stop + explicit PID/group/DB receipt completed BEFORE spawn.
      if (phases.length) expect(phases.at(-1)).toMatchObject({ dbOpen: false, ownedGroupEmpty: true, sockets: 0 })
      const app = await start445ActualApp({ mode: 'compiled', artifact, token, label, sharedBusiness: business })
      let owner: Awaited<ReturnType<typeof app445ReadControl>> | undefined, anonymous: Awaited<ReturnType<typeof app445ReadControl>> | undefined
      try {
        business ??= app.businessState
        const before = await app.snapshot(); if (!originalState) originalState = before; else expect(before).toEqual(originalState)
        for (const old of prior) {
          for (const [sid, headers] of [[old.authorized, { authorization: 'Bearer ' + token }], [old.anonymous, {}]] as const) {
            const denied = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44571, method: 'tools/list' }, { ...headers, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' })
            expect(denied.response.status).toBe(404); expect(denied.body.error).toEqual({ code: -32000, message: 'session_not_found', data: { code: 'session_not_found' } })
          }
        }
        const wrong = await app.rpc('/mcp-session', APP445_INIT, { authorization: 'Bearer ' + obsoleteToken })
        expect(wrong.response.status).toBe(401); expect(wrong.body.error.message).toBe('invalid_identity')
        owner = await app445ReadControl(app, true); anonymous = await app445ReadControl(app)
        const authorizedSID = owner.transport.sessionId, anonymousSID = anonymous.transport.sessionId
        expect(typeof authorizedSID).toBe('string'); expect(typeof anonymousSID).toBe('string'); expect(authorizedSID === anonymousSID).toBe(false)
        expect(prior.some(old => [old.authorized, old.anonymous].includes(authorizedSID!) || [old.authorized, old.anonymous].includes(anonymousSID!))).toBe(false)
        // close() aborts client streams; it does NOT send DELETE. Prove both SIDs
        // still live before process exit, so restart404 cannot be explained by DELETE.
        await owner.client.close(); await anonymous.client.close()
        for (const [sid, headers] of [[authorizedSID!, { authorization: 'Bearer ' + token }], [anonymousSID!, {}]] as const) {
          const live = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44572, method: 'tools/list' }, { ...headers, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' })
          expect(live.response.status).toBe(200); expect(live.body.result.tools.map((tool: any) => tool.name).sort()).toEqual(['get_enterprise_detail', 'list_enterprises'])
        }
        prior.push({ authorized: authorizedSID!, anonymous: anonymousSID! }) // Memory only; never serialized/hash logged.
        expect(await app.snapshot()).toEqual(originalState); await app.provenance()
        app.record({ kind: 'process-epoch', label, oldRegistrySids404: prior.length - 1, bothNewClientsRead: true, oldSidsLiveBeforeStop: true, zeroBusinessEffects: true, artifactSHA256: artifact.manifestSHA256 })
      } finally {
        try { await owner?.client.close(); await anonymous?.client.close() } finally { await app.stop() }
        const closed = await app.closedReceipt(); phases.push({ label, ...closed }); await artifact.verify()
        await fs.writeFile(join(dirname(tmpdir()), 'three-process-epoch.json'), JSON.stringify({ tokenCycle: ['A', 'B', 'A'], sameArtifactSHA256: artifact.manifestSHA256, sameBusinessDirectory: business?.directory, processCloses: phases, sidValuesPersisted: false }, null, 2), { mode: 0o600 })
      }
    }
    expect(phases).toHaveLength(3); expect(prior).toHaveLength(3)
  }, 300000)
})

// Parent corrected the over-specific 503 oracle: the frozen contract is exact
// 401 invalid_identity, including after restoring A. Original 503 candidate retained off-Git.
describe.skipIf(process.env.ISSUE445_PHASE !== 'app-compiled-sticky')('445 actual app compiled sticky', () => {
  it('S_same_process_env_observed_B_A_stays_401_for_initialize_and_existing', async () => {
    const fs = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { randomBytes } = await import('node:crypto')
    const grant = JSON.parse(await fs.readFile(join(dirname(tmpdir()), 'grant.raw'), 'utf8'))
    const artifact = await compiled445Artifact(), app = await start445ActualApp({ mode: 'compiled', artifact, stickyControlNonce: grant.nonce })
    let owner: Awaited<ReturnType<typeof app445ReadControl>> | undefined
    try {
      owner = await app445ReadControl(app, true)
      const sid = owner.transport.sessionId; expect(typeof sid).toBe('string')
      const before = await app.snapshot(), tokenB = randomBytes(24).toString('hex'); expect(tokenB === app.token).toBe(false)
      const observed: { seq: number; dispatch: string; status: number; error: unknown }[] = []
      for (const [seq, token] of [[1, tokenB], [2, app.token]] as const) {
        await app.setStickyCredential(token)
        // The read-only public afterResponse hook checks this SAME event's already-populated config cache.
        const initialize = await app.rpc('/mcp-session', APP445_INIT, { authorization: 'Bearer ' + token })
        app.record({ kind: 'sticky-initialize-observed', seq, status: initialize.response.status, invalidIdentity: initialize.body.error?.message === 'invalid_identity' })
        await app.stickyCurrentConfigWitness(seq)
        observed.push({ seq, dispatch: 'initialize', status: initialize.response.status, error: initialize.body.error })
        const existing = await app.rpc('/mcp-session', { jsonrpc: '2.0', id: 44583, method: 'tools/list' }, { authorization: 'Bearer ' + app.token, 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-03-26' })
        await app.stickyCurrentConfigWitness(seq)
        observed.push({ seq, dispatch: 'existing', status: existing.response.status, error: existing.body.error })
        app.record({ kind: 'sticky-existing-observed', seq, status: existing.response.status, invalidIdentity: existing.body.error?.message === 'invalid_identity' })
      }
      expect(await app.snapshot()).toEqual(before)
      await app.provenance()
      expect(observed).toEqual([1, 2].flatMap(seq => ['initialize', 'existing'].map(dispatch => ({ seq, dispatch, status: 401, error: { code: -32000, message: 'invalid_identity' } }))))
      app.record({ kind: 'sticky-complete', initializedOwnerRealRead: true, envBObserved: true, restoredAStill401: true, zeroBusinessEffects: true, inflightHandlerClosure: 'UNKNOWN: no public controllable enterprise handler gate' })
    } finally {
      try { await owner?.client.close() } finally { await app.stop(); await app.closedReceipt(); await artifact.verify() }
    }
  }, 180000)
})
